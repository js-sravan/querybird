package export

import (
	"archive/zip"
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Service provides table export and backup capabilities.
type Service struct {
	Conn *pgxpool.Pool
	Mu   *sync.Mutex
}

// NewService creates a new Export Service.
func NewService(conn *pgxpool.Pool, mu *sync.Mutex) *Service {
	return &Service{
		Conn: conn,
		Mu:   mu,
	}
}

// ExportCSV exports the selected tables in a schema to separate CSV files inside a single ZIP file.
func (s *Service) ExportCSV(ctx context.Context, schema string, tables []string, destZipPath string) error {
	s.Mu.Lock()
	defer s.Mu.Unlock()

	if s.Conn == nil {
		return fmt.Errorf("database connection is not open")
	}

	zipFile, err := os.Create(destZipPath)
	if err != nil {
		return fmt.Errorf("failed to create zip file: %w", err)
	}
	defer zipFile.Close()

	zipWriter := zip.NewWriter(zipFile)
	defer zipWriter.Close()

	for _, table := range tables {
		if err := s.exportTableToCSVStream(ctx, schema, table, zipWriter); err != nil {
			return fmt.Errorf("failed to export table %q: %w", table, err)
		}
	}

	return nil
}

// BackupSQL generates a single SQL script with schema definitions and insert statements.
func (s *Service) BackupSQL(ctx context.Context, schema string, tables []string, destSqlPath string) error {
	s.Mu.Lock()
	defer s.Mu.Unlock()

	if s.Conn == nil {
		return fmt.Errorf("database connection is not open")
	}

	sqlFile, err := os.Create(destSqlPath)
	if err != nil {
		return fmt.Errorf("failed to create SQL file: %w", err)
	}
	defer sqlFile.Close()

	// Add helper header comments
	header := fmt.Sprintf("-- QueryBird Database Backup\n-- Database: %s\n-- Schema: %s\n-- Generated: %s\n\n",
		s.Conn.Config().ConnConfig.Database, schema, time.Now().Format(time.RFC3339))
	if _, err := sqlFile.WriteString(header); err != nil {
		return err
	}

	for _, table := range tables {
		// 1. Write CREATE TABLE schema
		schemaSQL, err := s.getTableSchemaSQL(ctx, schema, table)
		if err != nil {
			return fmt.Errorf("failed to generate schema for table %q: %w", table, err)
		}
		if _, err := sqlFile.WriteString(schemaSQL + "\n"); err != nil {
			return err
		}

		// 2. Write INSERT statements
		if err := s.backupTableToSQLStream(ctx, schema, table, sqlFile); err != nil {
			return fmt.Errorf("failed to backup data for table %q: %w", table, err)
		}
		if _, err := sqlFile.WriteString("\n"); err != nil {
			return err
		}
	}

	return nil
}

func (s *Service) exportTableToCSVStream(ctx context.Context, schema, table string, zw *zip.Writer) error {
	qualifiedName := pgx.Identifier{schema, table}.Sanitize()
	query := fmt.Sprintf("SELECT * FROM %s", qualifiedName)

	rows, err := s.Conn.Query(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()

	// Create CSV file in ZIP
	csvFile, err := zw.Create(fmt.Sprintf("%s.csv", table))
	if err != nil {
		return err
	}

	csvWriter := csv.NewWriter(csvFile)
	defer csvWriter.Flush()

	// Write header
	fields := rows.FieldDescriptions()
	headers := make([]string, len(fields))
	for i, f := range fields {
		headers[i] = string(f.Name)
	}

	if err := csvWriter.Write(headers); err != nil {
		return err
	}

	// Stream rows
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return err
		}

		rowRecord := make([]string, len(values))
		for i, val := range values {
			rowRecord[i] = formatCSVValue(val)
		}

		if err := csvWriter.Write(rowRecord); err != nil {
			return err
		}
	}

	return rows.Err()
}

func (s *Service) backupTableToSQLStream(ctx context.Context, schema, table string, w io.Writer) error {
	qualifiedName := pgx.Identifier{schema, table}.Sanitize()
	query := fmt.Sprintf("SELECT * FROM %s", qualifiedName)

	rows, err := s.Conn.Query(ctx, query)
	if err != nil {
		return err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	if len(fields) == 0 {
		return nil
	}

	columns := make([]string, len(fields))
	for i, f := range fields {
		columns[i] = pgx.Identifier{string(f.Name)}.Sanitize()
	}
	columnsList := strings.Join(columns, ", ")

	// Stream rows and write INSERT statements
	for rows.Next() {
		values, err := rows.Values()
		if err != nil {
			return err
		}

		valStrings := make([]string, len(values))
		for i, val := range values {
			valStrings[i] = formatSQLValue(val)
		}
		valuesList := strings.Join(valStrings, ", ")

		insertStmt := fmt.Sprintf("INSERT INTO %s (%s) VALUES (%s);\n", qualifiedName, columnsList, valuesList)
		if _, err := io.WriteString(w, insertStmt); err != nil {
			return err
		}
	}

	return rows.Err()
}

func (s *Service) getTableSchemaSQL(ctx context.Context, schema, table string) (string, error) {
	query := `
		SELECT 
			a.attname AS column_name,
			pg_catalog.format_type(a.atttypid, a.atttypmod) AS column_type,
			NOT a.attnotnull AS is_nullable,
			COALESCE(pg_catalog.pg_get_expr(d.adbin, d.adrelid), '') AS column_default,
			a.attidentity AS identity_type,
			COALESCE((
				SELECT true 
				FROM pg_index i 
				WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
			), false) AS is_primary_key,
			COALESCE((
				SELECT true 
				FROM pg_constraint con 
				WHERE con.conrelid = c.oid AND con.contype = 'u' AND a.attnum = ANY(con.conkey)
			), false) AS is_unique
		FROM pg_catalog.pg_attribute a
		JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
		WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attnum
	`
	rows, err := s.Conn.Query(ctx, query, schema, table)
	if err != nil {
		return "", err
	}
	defer rows.Close()

	var columns []string
	var pkeys []string

	for rows.Next() {
		var colName, colType, colDefault string
		var isNullable, isPk, isUnique bool
		var identityStr string

		if err := rows.Scan(&colName, &colType, &isNullable, &colDefault, &identityStr, &isPk, &isUnique); err != nil {
			return "", err
		}

		parts := []string{pgx.Identifier{colName}.Sanitize(), colType}

		if identityStr == "a" {
			parts = append(parts, "GENERATED ALWAYS AS IDENTITY")
		} else if identityStr == "d" {
			parts = append(parts, "GENERATED BY DEFAULT AS IDENTITY")
		} else if colDefault != "" {
			parts = append(parts, "DEFAULT "+colDefault)
		}

		if !isNullable {
			parts = append(parts, "NOT NULL")
		}

		if isUnique {
			parts = append(parts, "UNIQUE")
		}

		if isPk {
			pkeys = append(pkeys, pgx.Identifier{colName}.Sanitize())
		}

		columns = append(columns, strings.Join(parts, " "))
	}

	if err := rows.Err(); err != nil {
		return "", err
	}

	if len(columns) == 0 {
		return "", fmt.Errorf("no columns found for table %s.%s", schema, table)
	}

	if len(pkeys) > 0 {
		columns = append(columns, "PRIMARY KEY ("+strings.Join(pkeys, ", ")+")")
	}

	qualifiedName := pgx.Identifier{schema, table}.Sanitize()
	sb := &strings.Builder{}
	sb.WriteString(fmt.Sprintf("CREATE TABLE IF NOT EXISTS %s (\n", qualifiedName))
	for i, col := range columns {
		sb.WriteString("    " + col)
		if i < len(columns)-1 {
			sb.WriteString(",")
		}
		sb.WriteString("\n")
	}
	sb.WriteString(");\n")
	return sb.String(), nil
}

func formatCSVValue(val any) string {
	if val == nil {
		return ""
	}
	switch v := val.(type) {
	case []byte:
		return string(v)
	case time.Time:
		return v.Format(time.RFC3339Nano)
	case [16]byte:
		u := pgtype.UUID{Bytes: v, Valid: true}
		t, _ := u.Value()
		if tStr, ok := t.(string); ok {
			return tStr
		}
		return fmt.Sprintf("%x-%x-%x-%x-%x", v[0:4], v[4:6], v[6:8], v[8:10], v[10:16])
	default:
		return fmt.Sprintf("%v", v)
	}
}

func formatSQLValue(val any) string {
	if val == nil {
		return "NULL"
	}
	switch v := val.(type) {
	case bool:
		if v {
			return "true"
		}
		return "false"
	case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64:
		return fmt.Sprintf("%d", v)
	case float32, float64:
		return fmt.Sprintf("%g", v)
	case string:
		return "'" + strings.ReplaceAll(v, "'", "''") + "'"
	case []byte:
		return fmt.Sprintf("decode('%x', 'hex')", v)
	case time.Time:
		return "'" + v.Format("2006-01-02 15:04:05.999999-07:00") + "'"
	case [16]byte:
		u := pgtype.UUID{Bytes: v, Valid: true}
		t, _ := u.Value()
		if tStr, ok := t.(string); ok {
			return "'" + strings.ReplaceAll(tStr, "'", "''") + "'"
		}
		uuidStr := fmt.Sprintf("%x-%x-%x-%x-%x", v[0:4], v[4:6], v[6:8], v[8:10], v[10:16])
		return "'" + uuidStr + "'"
	default:
		s := fmt.Sprintf("%v", v)
		return "'" + strings.ReplaceAll(s, "'", "''") + "'"
	}
}
