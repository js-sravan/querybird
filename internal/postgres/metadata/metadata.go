package metadata

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"

	"dbclient/internal/models"
)

// browseTimeout is applied to all QueryBird-generated browsing queries.
// It does not apply to user-authored SQL.
const browseTimeout = 30 * time.Second

// maxDisplayBytes is the server-side limit for TEXT/JSON/VARCHAR previews.
// Values longer than this are truncated by PostgreSQL before being sent over
// the wire. The frontend can detect truncation and offer a "click to expand".
const maxDisplayBytes = 500

// safeFilterOperators is the closed set of allowed operators for server-side
// table browsing filters. Using a whitelist prevents SQL injection via the
// operator field.
var safeFilterOperators = map[string]string{
	"=":           "=",
	"<>":          "<>",
	">":           ">",
	">=":          ">=",
	"<":           "<",
	"<=":          "<=",
	"LIKE":        "LIKE",
	"ILIKE":       "ILIKE",
	"NOT LIKE":    "NOT LIKE",
	"NOT ILIKE":   "NOT ILIKE",
	"IS NULL":     "IS NULL",
	"IS NOT NULL": "IS NOT NULL",
}

type Service struct {
	Conn *pgx.Conn
	// Mu is the shared connection mutex; must be held for every query on Conn.
	// Shared with query.Service so the two never race on the same *pgx.Conn.
	Mu *sync.Mutex

	// structureCache caches TableStructure results for the current session.
	// The cache is keyed by "schema\x00table" and populated on first access.
	// It is invalidated explicitly via InvalidateTableCache after DDL operations
	// (CREATE/ALTER/DROP TABLE/INDEX). The cache lives only as long as the
	// Service instance — reconnect creates a new Service, clearing the cache.
	structureCacheMu sync.RWMutex
	structureCache   map[string][]models.ColumnInfo
}

func NewService(conn *pgx.Conn, mu *sync.Mutex) *Service {
	return &Service{
		Conn:           conn,
		Mu:             mu,
		structureCache: make(map[string][]models.ColumnInfo),
	}
}

// InvalidateTableCache removes the cached structure for a specific table.
// Call this after DDL that modifies the table (ALTER TABLE, DROP TABLE, etc.).
func (s *Service) InvalidateTableCache(schema, table string) {
	key := schema + "\x00" + table
	s.structureCacheMu.Lock()
	delete(s.structureCache, key)
	s.structureCacheMu.Unlock()
}

// InvalidateSchemaCache removes all cached structures for a given schema.
// Call this after schema-level DDL (CREATE TABLE, DROP TABLE, etc.).
func (s *Service) InvalidateSchemaCache(schema string) {
	prefix := schema + "\x00"
	s.structureCacheMu.Lock()
	for k := range s.structureCache {
		if strings.HasPrefix(k, prefix) {
			delete(s.structureCache, k)
		}
	}
	s.structureCacheMu.Unlock()
}

func (s *Service) Databases(ctx context.Context) ([]string, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	rows, err := s.Conn.Query(ctx, `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

func (s *Service) Schemas(ctx context.Context) ([]string, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	rows, err := s.Conn.Query(ctx, `SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('information_schema','pg_catalog','pg_toast') AND nspname NOT LIKE 'pg_%' ORDER BY nspname`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]string, 0)
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		out = append(out, name)
	}
	return out, rows.Err()
}

// DatabasesAndSchemas fetches both in one round-trip for fast connection startup.
func (s *Service) DatabasesAndSchemas(ctx context.Context) (databases []string, schemas []string, err error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	batch := &pgx.Batch{}
	batch.Queue(`SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname`)
	batch.Queue(`SELECT nspname FROM pg_catalog.pg_namespace WHERE nspname NOT IN ('information_schema','pg_catalog','pg_toast') AND nspname NOT LIKE 'pg_%' ORDER BY nspname`)
	br := s.Conn.SendBatch(ctx, batch)
	defer br.Close()

	dbRows, err := br.Query()
	if err != nil {
		return nil, nil, err
	}
	for dbRows.Next() {
		var name string
		if err := dbRows.Scan(&name); err != nil {
			dbRows.Close()
			return nil, nil, err
		}
		databases = append(databases, name)
	}
	dbRows.Close()

	schRows, err := br.Query()
	if err != nil {
		return nil, nil, err
	}
	for schRows.Next() {
		var name string
		if err := schRows.Scan(&name); err != nil {
			schRows.Close()
			return nil, nil, err
		}
		schemas = append(schemas, name)
	}
	schRows.Close()

	return databases, schemas, nil
}

func (s *Service) Objects(ctx context.Context, schema string) ([]models.DatabaseObject, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	if schema == "" {
		schema = "public"
	}
	query := `
		SELECT table_name AS name, 'table' AS object_type FROM information_schema.tables
		WHERE table_schema = $1 AND table_type = 'BASE TABLE'
		UNION ALL
		SELECT indexname AS name, 'index' AS object_type FROM pg_indexes WHERE schemaname = $1
		UNION ALL
		SELECT table_name AS name, 'view' AS object_type FROM information_schema.views WHERE table_schema = $1
		UNION ALL
		SELECT matviewname AS name, 'materialized_view' AS object_type FROM pg_matviews WHERE schemaname = $1
		UNION ALL
		SELECT relname AS name, 'sequence' AS object_type FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind = 'S'
		UNION ALL
		SELECT proname AS name, 'function' AS object_type FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
		UNION ALL
		SELECT typname AS name, 'type' AS object_type FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = $1 AND t.typtype IN ('b', 'c', 'd', 'e', 'p', 'r', 'u')
		UNION ALL
		SELECT domain_name AS name, 'domain' AS object_type FROM information_schema.domains WHERE domain_schema = $1
		UNION ALL
		SELECT extname AS name, 'extension' AS object_type FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace WHERE n.nspname = $1
		ORDER BY object_type, name
	`

	rows, err := s.Conn.Query(ctx, query, schema)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.DatabaseObject, 0)
	for rows.Next() {
		var name, typ string
		if err := rows.Scan(&name, &typ); err != nil {
			return nil, err
		}
		out = append(out, models.DatabaseObject{Name: name, Type: typ})
	}
	return out, rows.Err()
}

func (s *Service) TableStructure(ctx context.Context, schema, table string) ([]models.ColumnInfo, error) {
	// Fast path: return cached structure if available.
	key := schema + "\x00" + table
	s.structureCacheMu.RLock()
	if cached, ok := s.structureCache[key]; ok {
		s.structureCacheMu.RUnlock()
		return cached, nil
	}
	s.structureCacheMu.RUnlock()

	s.Mu.Lock()
	defer s.Mu.Unlock()
	query := `
		SELECT
			c.ordinal_position,
			c.column_name,
			c.data_type,
			c.is_nullable = 'YES',
			COALESCE(c.column_default, ''),
			c.is_generated = 'ALWAYS',
			c.is_identity = 'YES',
			CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END,
			CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END,
			CASE WHEN uq.column_name IS NOT NULL THEN true ELSE false END,
			COALESCE(col_description(p.oid, c.ordinal_position), '')
		FROM information_schema.columns c
		LEFT JOIN pg_class p ON p.relname = $2 AND p.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
		LEFT JOIN (
			SELECT kcu.column_name, kcu.table_schema, kcu.table_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
			WHERE tc.constraint_type = 'PRIMARY KEY'
		) pk ON pk.table_schema = c.table_schema AND pk.table_name = c.table_name AND pk.column_name = c.column_name
		LEFT JOIN (
			SELECT kcu.column_name, kcu.table_schema, kcu.table_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
			WHERE tc.constraint_type = 'FOREIGN KEY'
		) fk ON fk.table_schema = c.table_schema AND fk.table_name = c.table_name AND fk.column_name = c.column_name
		LEFT JOIN (
			SELECT kcu.column_name, kcu.table_schema, kcu.table_name
			FROM information_schema.table_constraints tc
			JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
			WHERE tc.constraint_type = 'UNIQUE'
		) uq ON uq.table_schema = c.table_schema AND uq.table_name = c.table_name AND uq.column_name = c.column_name
		WHERE c.table_schema = $1 AND c.table_name = $2
		ORDER BY c.ordinal_position`

	rows, err := s.Conn.Query(ctx, query, schema, table)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]models.ColumnInfo, 0)
	for rows.Next() {
		var (
			ordinal    int
			name       string
			typ        string
			nullable   bool
			defaultVal string
			generated  bool
			identity   bool
			isPk       bool
			isFk       bool
			isUnique   bool
			comment    string
		)
		if err := rows.Scan(&ordinal, &name, &typ, &nullable, &defaultVal, &generated, &identity, &isPk, &isFk, &isUnique, &comment); err != nil {
			return nil, err
		}
		out = append(out, models.ColumnInfo{
			Ordinal:      ordinal,
			Name:         name,
			Type:         typ,
			Nullable:     nullable,
			Default:      defaultVal,
			IsGenerated:  generated,
			IsIdentity:   identity,
			IsPrimaryKey: isPk,
			IsForeignKey: isFk,
			IsUnique:     isUnique,
			Comment:      comment,
		})
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// Populate the cache now that we have a clean result.
	s.structureCacheMu.Lock()
	s.structureCache[key] = out
	s.structureCacheMu.Unlock()

	return out, nil
}

func quotedTableName(schema, table string) string {
	if schema == "" || table == "" {
		return `""`
	}
	return pgx.Identifier{schema, table}.Sanitize()
}

// CellValue fetches the full unrestricted value of a single cell identified by
// its primary-key column + value. Used by the frontend "click to expand" feature.
func (s *Service) CellValue(ctx context.Context, schema, table, pkColumn, pkValue, column string) (string, error) {
	s.Mu.Lock()
	defer s.Mu.Unlock()
	qualified := quotedTableName(schema, table)
	pkCol := pgx.Identifier{pkColumn}.Sanitize()
	col := pgx.Identifier{column}.Sanitize()
	query := fmt.Sprintf("SELECT %s::text FROM %s WHERE %s = $1::text LIMIT 1", col, qualified, pkCol)
	var val *string
	if err := s.Conn.QueryRow(ctx, query, pkValue).Scan(&val); err != nil {
		return "", err
	}
	if val == nil {
		return "NULL", nil
	}
	return *val, nil
}

// tableMetaResult holds the pg_catalog metadata retrieved in a single round-trip
// before building the data query.
type tableMetaResult struct {
	totalRows int64
	pkName    string
	cols      []string
	typeOIDs  []int64
}

// loadTableMeta retrieves row estimate, primary key, column names, and type OIDs
// in one query using pg_catalog (fast, avoids information_schema joins).
func (s *Service) loadTableMeta(ctx context.Context, schema, table string) (*tableMetaResult, error) {
	metaQuery := `
		SELECT
			GREATEST(c.reltuples::bigint, 0),
			COALESCE(
				(SELECT string_agg(a.attname, ',' ORDER BY pk.ordinality)
				 FROM pg_index i
				 JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS pk(attnum, ordinality) ON true
				 JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = pk.attnum
				 WHERE i.indrelid = c.oid AND i.indisprimary
				), ''
			),
			ARRAY(SELECT a.attname       FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum),
			ARRAY(SELECT a.atttypid::int FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum)
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1 AND c.relname = $2
	`
	var res tableMetaResult
	if err := s.Conn.QueryRow(ctx, metaQuery, schema, table).Scan(
		&res.totalRows, &res.pkName, &res.cols, &res.typeOIDs,
	); err != nil {
		return nil, err
	}
	return &res, nil
}

// buildSelectCols builds a type-aware SELECT list. Bytea columns show a placeholder
// while text, JSON, and all other column types are returned with their full content.
func buildSelectCols(cols []string, typeOIDs []int64) string {
	selectCols := make([]string, len(cols))
	for i, col := range cols {
		quoted := pgx.Identifier{col}.Sanitize()
		var oid int64
		if i < len(typeOIDs) {
			oid = typeOIDs[i]
		}
		switch oid {
		case 17: // bytea — never useful to display raw; show placeholder
			selectCols[i] = fmt.Sprintf("'[bytea]'::text AS %s", quoted)
		default:
			selectCols[i] = quoted
		}
	}
	return strings.Join(selectCols, ", ")
}

func (s *Service) TableData(ctx context.Context, schema string, table string, page int, pageSize int, sortColumn string, sortDirection string) (*models.TableDataPage, error) {
	return s.tableDataInternal(ctx, schema, table, page, pageSize, sortColumn, sortDirection, nil)
}

// FilteredTableData executes a server-side filtered table browse query.
// The filter operator is validated against the safe whitelist; the value is
// passed as a parameter to prevent SQL injection.
func (s *Service) FilteredTableData(ctx context.Context, schema string, table string, page int, pageSize int, sortColumn string, sortDirection string, filter models.TableLookupFilter) (*models.TableDataPage, error) {
	return s.tableDataInternal(ctx, schema, table, page, pageSize, sortColumn, sortDirection, &filter)
}

func (s *Service) tableDataInternal(ctx context.Context, schema string, table string, page int, pageSize int, sortColumn string, sortDirection string, filter *models.TableLookupFilter) (*models.TableDataPage, error) {
	if schema == "" {
		schema = "public"
	}
	if table == "" {
		return nil, fmt.Errorf("table name required")
	}
	if page < 1 {
		page = 1
	}
	if pageSize < 1 {
		pageSize = 50
	}
	if pageSize > 500 {
		pageSize = 500
	}

	// Apply a statement timeout to all internal browsing queries so they don't
	// hang forever on high-latency or overloaded connections.
	browseCtx, cancel := context.WithTimeout(ctx, browseTimeout)
	defer cancel()

	s.Mu.Lock()
	defer s.Mu.Unlock()

	qualified := quotedTableName(schema, table)

	meta, err := s.loadTableMeta(browseCtx, schema, table)
	if err != nil {
		return nil, err
	}

	if sortDirection == "" {
		sortDirection = "ASC"
	}
	orderBy := "1"
	if sortColumn != "" {
		orderBy = pgx.Identifier{sortColumn}.Sanitize()
	} else if len(meta.cols) > 0 {
		orderBy = pgx.Identifier{meta.cols[0]}.Sanitize()
	}

	colList := buildSelectCols(meta.cols, meta.typeOIDs)

	// Fetch pageSize+1 rows so we can detect whether a next page exists without
	// running COUNT(*). We discard the extra row before returning.
	fetchLimit := pageSize + 1

	var dataQuery string
	var args []any

	if filter != nil {
		// Validate operator against the safe whitelist.
		safeOp, ok := safeFilterOperators[strings.ToUpper(filter.Operator)]
		if !ok {
			return nil, fmt.Errorf("unsupported filter operator: %q", filter.Operator)
		}
		filterCol := pgx.Identifier{filter.Column}.Sanitize()
		if safeOp == "IS NULL" || safeOp == "IS NOT NULL" {
			dataQuery = fmt.Sprintf(
				"SELECT %s FROM %s WHERE %s %s ORDER BY %s %s LIMIT $1 OFFSET $2",
				colList, qualified, filterCol, safeOp, orderBy, sortDirection,
			)
			args = []any{fetchLimit, (page - 1) * pageSize}
		} else {
			dataQuery = fmt.Sprintf(
				"SELECT %s FROM %s WHERE %s %s $3 ORDER BY %s %s LIMIT $1 OFFSET $2",
				colList, qualified, filterCol, safeOp, orderBy, sortDirection,
			)
			args = []any{fetchLimit, (page - 1) * pageSize, filter.Value}
		}
	} else {
		dataQuery = fmt.Sprintf("SELECT %s FROM %s ORDER BY %s %s LIMIT $1 OFFSET $2", colList, qualified, orderBy, sortDirection)
		args = []any{fetchLimit, (page - 1) * pageSize}
	}

	rows, err := s.Conn.Query(browseCtx, dataQuery, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	values, colsOut, err := readRows(rows)
	if err != nil {
		return nil, err
	}

	// Detect next-page availability from the extra row.
	hasNextPage := len(values) > pageSize
	if hasNextPage {
		values = values[:pageSize]
	}

	return &models.TableDataPage{
		Columns:     colsOut,
		Rows:        values,
		TotalRows:   meta.totalRows,
		HasNextPage: hasNextPage,
		Page:        page,
		PageSize:    pageSize,
		PrimaryKey:  meta.pkName,
	}, nil
}

func readRows(rows pgx.Rows) ([]map[string]any, []string, error) {
	fieldDescriptions := rows.FieldDescriptions()
	cols := make([]string, len(fieldDescriptions))
	for i, desc := range fieldDescriptions {
		cols[i] = string(desc.Name)
	}

	data := make([]map[string]any, 0)
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return nil, nil, err
		}
		row := make(map[string]any, len(cols))
		for i, col := range cols {
			row[col] = normalizeValue(values[i])
		}
		data = append(data, row)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return data, cols, nil
}

func normalizeValue(v any) any {
	switch value := v.(type) {
	case []byte:
		return string(value)
	case [16]byte:
		// pgx v5 decodes UUID columns as [16]byte — format as standard UUID string
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
