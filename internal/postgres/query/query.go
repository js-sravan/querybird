package query

import (
	"context"
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"dbclient/internal/models"
)

// maxQueryDisplayRunes is the per-cell character limit applied when reading
// user SQL query results. Values longer than this are truncated in Go and the
// column name is recorded in TruncatedColumns so the UI can offer "expand".
// This matches the table-browser server-side limit.
const maxQueryDisplayRunes = 500

type Service struct {
	Conn *pgx.Conn
	// Mu must be held for the entire duration of every query against Conn.
	// pgx *pgx.Conn is not goroutine-safe: attempting to run two queries
	// concurrently on the same connection produces "conn busy" errors.
	// The App layer passes this mutex in so that metadata and query services
	// share the same lock over the single underlying connection.
	Mu *sync.Mutex

	// cancelMu guards cancelFn and isRunning.
	cancelMu  sync.Mutex
	cancelFn  context.CancelFunc
	isRunning bool
}

func NewService(conn *pgx.Conn, mu *sync.Mutex) *Service {
	return &Service{Conn: conn, Mu: mu}
}

// IsRunning returns whether a user query is currently executing.
// Used by the frontend to show/hide the running indicator.
func (s *Service) IsRunning() bool {
	s.cancelMu.Lock()
	defer s.cancelMu.Unlock()
	return s.isRunning
}

// Cancel cancels the currently-executing user query (if any).
// The cancellation is delivered as a context cancellation; pgx will send a
// PostgreSQL cancel request over a separate connection so the server also
// stops processing the query. Safe to call when no query is running.
func (s *Service) Cancel() {
	s.cancelMu.Lock()
	fn := s.cancelFn
	s.cancelMu.Unlock()
	if fn != nil {
		fn()
	}
}

func (s *Service) Execute(ctx context.Context, sql string) (*models.QueryResult, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()

	// Wrap the caller's context with a cancel so CancelQuery can interrupt us.
	queryCtx, cancel := context.WithCancel(ctx)
	s.cancelMu.Lock()
	s.cancelFn = cancel
	s.isRunning = true
	s.cancelMu.Unlock()

	defer func() {
		cancel() // always release the cancel func
		s.cancelMu.Lock()
		s.cancelFn = nil
		s.isRunning = false
		s.cancelMu.Unlock()
	}()

	// For simple SELECT * FROM schema.table queries, rewrite the projection to
	// apply LEFT() server-side on large-value columns (text/json/bytea/xml).
	// This is the only way to reduce wire transfer: wrapping the full query in
	// an outer SELECT LEFT() doesn't help because the inner query already
	// materialises the full rows before the outer truncation is applied.
	//
	// For any SQL that doesn't match the simple pattern (JOINs, expressions,
	// CTEs, user-defined projections) the query runs exactly as written.
	execSQL := rewriteSelectStar(sql, s.Conn, queryCtx)

	dbStart := time.Now()
	rows, err := s.Conn.Query(queryCtx, execSQL)
	dbMs := time.Since(dbStart).Milliseconds()
	if err != nil {
		if queryCtx.Err() == context.Canceled {
			return nil, fmt.Errorf("Query cancelled.")
		}
		// Wrapper failed — fall back to the original SQL.
		if execSQL != sql {
			rows, err = s.Conn.Query(queryCtx, sql)
			if err != nil {
				return nil, err
			}
		} else {
			return nil, err
		}
	}
	defer rows.Close()

	cols := rows.FieldDescriptions()
	columnNames := make([]string, len(cols))
	for i, col := range cols {
		columnNames[i] = string(col.Name)
	}

	transferStart := time.Now()
	rowData := make([]map[string]any, 0)
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, err
		}
		row := make(map[string]any, len(columnNames))
		for i, col := range columnNames {
			row[col] = normalizeValue(values[i])
		}
		rowData = append(rowData, row)
	}
	if err := rows.Err(); err != nil {
		if queryCtx.Err() == context.Canceled {
			return nil, fmt.Errorf("Query cancelled.")
		}
		return nil, err
	}
	transferMs := time.Since(transferStart).Milliseconds()
	totalMs := dbMs + transferMs

	msg := "Query completed successfully"
	if len(columnNames) == 0 {
		msg = "Statement executed successfully"
	} else {
		msg = fmt.Sprintf("Completed in %d ms (db: %d ms, transfer: %d ms)", totalMs, dbMs, transferMs)
	}

	return &models.QueryResult{
		Columns:          columnNames,
		Rows:             rowData,
		RowCount:         len(rowData),
		Affected:         0,
		ExecutionMs:      totalMs,
		Success:          true,
		Message:          msg,
		TruncatedColumns: nil,
	}, nil
}

// isLargeTypeOID returns true for PostgreSQL type OIDs that commonly hold
// large values: text, varchar, char, bytea, json, jsonb, xml, and the
// variable-length "unknown" pseudo-type.
func isLargeTypeOID(oid uint32) bool {
	switch oid {
	case 17,          // bytea
		25,           // text
		114, 3802,    // json, jsonb
		142,          // xml
		1042, 1043,   // char, varchar
		705:          // unknown (literal string)
		return true
	}
	return false
}

// truncateDisplayValue clips a string value to maxQueryDisplayRunes runes.
// Returns the (possibly clipped) value and whether truncation occurred.
// Non-string values pass through unchanged.
func truncateDisplayValue(v any, _ string, alreadyTruncated bool) (any, bool) {
	switch s := v.(type) {
	case string:
		if utf8.RuneCountInString(s) > maxQueryDisplayRunes {
			// Trim to exactly maxQueryDisplayRunes runes.
			i := 0
			for pos := range s {
				if i == maxQueryDisplayRunes {
					return s[:pos], true
				}
				i++
			}
		}
		return s, alreadyTruncated
	default:
		return v, alreadyTruncated
	}
}


// rewriteSelectStar rewrites a simple "SELECT * FROM [schema.]table [LIMIT n]"
// query to use an explicit, type-aware column list that applies LEFT() to large
// columns (text/json/bytea/xml) at the PostgreSQL level — before any bytes
// travel over the network.
//
// Any SQL that does not match the exact pattern is returned unchanged so the
// user's query always executes as written.
//
// The rewrite is O(1) extra round-trips: one pg_catalog query to fetch column
// names and type OIDs, then the rewritten SELECT runs. This is equivalent to
// what the table browser does internally via loadTableMeta + buildSelectCols.
func rewriteSelectStar(sql string, conn *pgx.Conn, ctx context.Context) string {
	schema, table, suffix, ok := parseSelectStar(sql)
	if !ok {
		return sql
	}

	// Fetch column names + type OIDs from pg_catalog in one round-trip.
	const metaQ = `
		SELECT a.attname, a.atttypid::int8
		FROM pg_attribute a
		JOIN pg_class c ON c.oid = a.attrelid
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2
		  AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum`

	rows, err := conn.Query(ctx, metaQ, schema, table)
	if err != nil {
		return sql
	}
	defer rows.Close()

	type col struct {
		name string
		oid  int64
	}
	var cols []col
	for rows.Next() {
		var c col
		if err := rows.Scan(&c.name, &c.oid); err != nil {
			return sql
		}
		cols = append(cols, c)
	}
	if rows.Err() != nil || len(cols) == 0 {
		return sql
	}

	// Build a type-aware SELECT list — same logic as metadata.buildSelectCols.
	selectParts := make([]string, len(cols))
	hasLarge := false
	for i, c := range cols {
		quoted := pgx.Identifier{c.name}.Sanitize()
		switch c.oid {
		case 17: // bytea
			selectParts[i] = fmt.Sprintf("'[bytea]'::text AS %s", quoted)
			hasLarge = true
		default:
			selectParts[i] = quoted
		}
	}
	if !hasLarge {
		return sql // no large columns — no rewrite needed
	}

	qualified := pgx.Identifier{schema, table}.Sanitize()
	return fmt.Sprintf("SELECT %s FROM %s%s",
		strings.Join(selectParts, ", "),
		qualified,
		suffix,
	)
}

// parseSelectStar matches the pattern:
//
//	SELECT * FROM ["schema".]"table" [WHERE/ORDER BY/LIMIT/OFFSET/…]
//
// Returns schema, table, the trailing clause string (e.g. " LIMIT 50"), and
// true on success. Returns false for any SQL that doesn't fit this pattern —
// JOIN, expression projections, CTEs, subqueries, etc.
func parseSelectStar(sql string) (schema, table, suffix string, ok bool) {
	// Use a simple regex: anchored SELECT * FROM, optional schema, table name,
	// optional trailing clauses. Both quoted ("…") and unquoted identifiers.
	// We intentionally keep this narrow — false negatives are fine (user SQL
	// runs as-is), false positives would rewrite the wrong query.
	m := selectStarRe.FindStringSubmatch(strings.TrimSpace(sql))
	if m == nil {
		return "", "", "", false
	}
	// m[1]/m[2] = schema (quoted or unquoted), m[3]/m[4] = table, m[5] = suffix
	schema = coalesce(unquoteIdent(m[1]), m[2])
	table = coalesce(unquoteIdent(m[3]), m[4])
	suffix = m[5]
	if table == "" {
		return "", "", "", false
	}
	if schema == "" {
		schema = "public"
	}
	return schema, table, suffix, true
}

// selectStarRe matches: SELECT * FROM [schema.]table [trailing clauses] ;?
// Groups: (quoted-schema)(bare-schema)(quoted-table)(bare-table)(suffix)
var selectStarRe = regexp.MustCompile(
	`(?i)^\s*SELECT\s+\*\s+FROM\s+` +
		`(?:(?:"((?:""|[^"])*)"|([A-Za-z_][\w$]*))\s*\.\s*)?` +
		`(?:"((?:""|[^"])*)"|([A-Za-z_][\w$]*))` +
		`((?:\s+(?:WHERE|ORDER\s+BY|LIMIT|OFFSET|FETCH|FOR)\b[\s\S]*)?)` +
		`\s*;?\s*$`,
)

func unquoteIdent(s string) string {
	return strings.ReplaceAll(s, `""`, `"`)
}

func coalesce(a, b string) string {
	if a != "" {
		return a
	}
	return b
}


func (s *Service) SaveQueryResultEdits(ctx context.Context, schema, table string, updates []models.RowUpdate) error {
	if schema == "" || table == "" {
		return fmt.Errorf("schema and table are required")
	}
	if len(updates) == 0 {
		return nil
	}

	s.Mu.Lock()
	defer s.Mu.Unlock()

	tx, err := s.Conn.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() {
		_ = tx.Rollback(ctx)
	}()

	// Batch PK lookup + column metadata in one round-trip to reduce latency on
	// port-forwarded connections (was two sequential queries before).
	batch := &pgx.Batch{}
	batch.Queue(`
		SELECT COALESCE(string_agg(a.attname, ',' ORDER BY key_column.ordinality), '')
		FROM pg_catalog.pg_index i
		JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
		  ON key_column.ordinality <= i.indnkeyatts
		JOIN pg_catalog.pg_attribute a
		  ON a.attrelid = i.indrelid AND a.attnum = key_column.attnum
		JOIN pg_catalog.pg_class c ON c.oid = i.indrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE i.indisprimary AND n.nspname = $1 AND c.relname = $2
	`, schema, table)
	batch.Queue(`
		SELECT c.column_name, format_type(a.atttypid, a.atttypmod), c.is_generated = 'ALWAYS'
		FROM information_schema.columns c
		JOIN pg_catalog.pg_namespace n ON n.nspname = c.table_schema
		JOIN pg_catalog.pg_class r ON r.relnamespace = n.oid AND r.relname = c.table_name
		JOIN pg_catalog.pg_attribute a ON a.attrelid = r.oid AND a.attname = c.column_name
		WHERE c.table_schema = $1 AND c.table_name = $2
	`, schema, table)

	br := tx.SendBatch(ctx, batch)

	var primaryKey string
	if err := br.QueryRow().Scan(&primaryKey); err != nil {
		_ = br.Close()
		return err
	}

	columns := make(map[string]string)
	generatedColumns := make(map[string]bool)
	columnRows, err := br.Query()
	if err != nil {
		_ = br.Close()
		return err
	}
	for columnRows.Next() {
		var name string
		var typeName string
		var generated bool
		if err := columnRows.Scan(&name, &typeName, &generated); err != nil {
			columnRows.Close()
			_ = br.Close()
			return err
		}
		columns[name] = typeName
		generatedColumns[name] = generated
	}
	if err := columnRows.Err(); err != nil {
		columnRows.Close()
		_ = br.Close()
		return err
	}
	columnRows.Close()

	if err := br.Close(); err != nil {
		return err
	}

	if primaryKey == "" {
		return fmt.Errorf("cannot edit query results: table %s.%s has no primary key", schema, table)
	}
	pkColumns := strings.Split(primaryKey, ",")

	tableName := pgx.Identifier{schema, table}.Sanitize()
	for _, update := range updates {
		if len(update.Keys) != len(pkColumns) || len(update.Values) == 0 {
			return fmt.Errorf("each update must include every primary-key value and at least one changed value")
		}
		for _, key := range pkColumns {
			if _, ok := update.Keys[key]; !ok {
				return fmt.Errorf("missing primary-key value for column %q", key)
			}
		}
		for key := range update.Keys {
			if !containsColumn(pkColumns, key) {
				return fmt.Errorf("column %q is not part of the table primary key", key)
			}
		}

		valueColumns := make([]string, 0, len(update.Values))
		for name := range update.Values {
			_, exists := columns[name]
			if !exists {
				return fmt.Errorf("column %q does not exist in %s.%s", name, schema, table)
			}
			if generatedColumns[name] {
				return fmt.Errorf("generated column %q cannot be updated", name)
			}
			if containsColumn(pkColumns, name) {
				return fmt.Errorf("editing primary-key column %q is not supported", name)
			}
			valueColumns = append(valueColumns, name)
		}
		sort.Strings(valueColumns)

		args := make([]any, 0, len(valueColumns)+len(pkColumns))
		assignments := make([]string, 0, len(valueColumns))
		for _, name := range valueColumns {
			args = append(args, normalizeNumber(update.Values[name]))
			assignments = append(assignments, fmt.Sprintf("%s = $%d::%s", pgx.Identifier{name}.Sanitize(), len(args), columns[name]))
		}
		predicates := make([]string, 0, len(pkColumns))
		for _, name := range pkColumns {
			args = append(args, normalizeNumber(update.Keys[name]))
			predicates = append(predicates, fmt.Sprintf("%s = $%d", pgx.Identifier{name}.Sanitize(), len(args)))
		}
		query := fmt.Sprintf("UPDATE %s SET %s WHERE %s", tableName, strings.Join(assignments, ", "), strings.Join(predicates, " AND "))
		tag, err := tx.Exec(ctx, query, args...)
		if err != nil {
			return err
		}
		if tag.RowsAffected() != 1 {
			return fmt.Errorf("expected to update one row in %s.%s, updated %d", schema, table, tag.RowsAffected())
		}
	}

	return tx.Commit(ctx)
}

func containsColumn(columns []string, name string) bool {
	for _, column := range columns {
		if column == name {
			return true
		}
	}
	return false
}

func normalizeNumber(value any) any {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) {
		return value
	}
	if number >= math.MinInt64 && number <= math.MaxInt64 && math.Trunc(number) == number {
		return int64(number)
	}
	return number
}

func normalizeValue(v any) any {
	switch value := v.(type) {
	case []byte:
		return string(value)
	case [16]byte:
		u := pgtype.UUID{Bytes: value, Valid: true}
		t, _ := u.Value()
		if t != nil {
			return t
		}
		return fmt.Sprintf("%x-%x-%x-%x-%x", value[0:4], value[4:6], value[6:8], value[8:10], value[10:16])
	default:
		return value
	}
}
