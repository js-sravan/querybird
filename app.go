package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"sync"

	"dbclient/internal/models"
	"dbclient/internal/postgres/connection"
	"dbclient/internal/postgres/export"
	"dbclient/internal/postgres/metadata"
	"dbclient/internal/postgres/query"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx    context.Context
	conn   *connection.Service
	meta   *metadata.Service
	qrySvc *query.Service
	expSvc *export.Service
	// connMu serializes all queries against the single *pgx.Conn.
	// pgx single connections are not concurrency-safe; sharing this mutex
	// between meta and qrySvc ensures only one query runs at a time.
	connMu sync.Mutex
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{conn: connection.NewService()}
}

// startup is called when the app starts.
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) TestConnection(cfg models.ConnectionConfig) error {
	return a.conn.TestConnection(a.ctx, cfg)
}

func (a *App) Connect(cfg models.ConnectionConfig) (*models.ConnectionState, error) {
	state, err := a.conn.Connect(a.ctx, cfg)
	if err != nil {
		return nil, err
	}
	a.connMu = sync.Mutex{}
	a.meta = metadata.NewService(a.conn.Conn, &a.connMu)
	a.qrySvc = query.NewService(a.conn.Conn, &a.connMu)
	a.expSvc = export.NewService(a.conn.Conn, &a.connMu)
	// Fetch databases + schemas in one batched round-trip and return them
	// with the state so the frontend needs zero extra RPCs after Connect.
	dbs, schemas, err := a.meta.DatabasesAndSchemas(a.ctx)
	if err == nil {
		state.Databases = dbs
		state.Schemas = schemas
	}
	return state, nil
}

func (a *App) Disconnect() error {
	if a.conn == nil {
		return nil
	}
	a.conn.Close(a.ctx)
	a.meta = nil
	a.qrySvc = nil
	a.expSvc = nil
	return nil
}

// IsConnected returns true when a live PostgreSQL connection is held.
// The frontend calls this to determine whether to show the reconnect banner.
func (a *App) IsConnected() bool {
	return a.conn != nil && a.conn.IsConnected()
}

// handleDBError checks whether an error from a DB operation is a connection-loss
// error. If it is, it marks the connection as disconnected so the frontend can
// detect the state change via IsConnected(). Returns the classified error.
func (a *App) handleDBError(err error) error {
	if err == nil {
		return nil
	}
	classified := connection.ClassifyError(err)
	msg := classified.Error()
	// These messages are produced by ClassifyError for connection-loss conditions.
	if msg == "Connection lost. Check your port-forward or tunnel and reconnect." ||
		msg == "Connection lost unexpectedly. Check your port-forward or tunnel and reconnect." ||
		msg == "Connection timed out. Check the host, port, and network path." ||
		msg == "Network unreachable. Check your VPN, tunnel, or network connection." {
		log.Printf("[QueryBird] Mid-session connection loss detected: %v", err)
		a.conn.MarkDisconnected()
		a.meta = nil
		a.qrySvc = nil
		a.expSvc = nil
	}
	return classified
}

func (a *App) ListDatabases() ([]string, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.meta.Databases(a.ctx)
	return result, a.handleDBError(err)
}

func (a *App) ListSchemas() ([]string, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.meta.Schemas(a.ctx)
	return result, a.handleDBError(err)
}

func (a *App) ListObjects(schema string) ([]models.DatabaseObject, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.meta.Objects(a.ctx, schema)
	return result, a.handleDBError(err)
}

func (a *App) GetTableStructure(schema string, table string) ([]models.ColumnInfo, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.meta.TableStructure(a.ctx, schema, table)
	return result, a.handleDBError(err)
}

func (a *App) GetTableData(schema string, table string, page int, pageSize int, sortColumn string, sortDirection string) (*models.TableDataPage, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.meta.TableData(a.ctx, schema, table, page, pageSize, sortColumn, sortDirection)
	return result, a.handleDBError(err)
}

func (a *App) GetFilteredTableData(schema string, table string, page int, pageSize int, sortColumn string, sortDirection string, filter models.TableLookupFilter) (*models.TableDataPage, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.meta.FilteredTableData(a.ctx, schema, table, page, pageSize, sortColumn, sortDirection, filter)
	return result, a.handleDBError(err)
}

func (a *App) GetCellValue(schema string, table string, pkColumn string, pkValue string, column string) (string, error) {
	if !a.IsConnected() {
		return "", errors.New("not connected")
	}
	result, err := a.meta.CellValue(a.ctx, schema, table, pkColumn, pkValue, column)
	return result, a.handleDBError(err)
}

func (a *App) ExecuteQuery(sql string) (*models.QueryResult, error) {
	if !a.IsConnected() {
		return nil, errors.New("not connected")
	}
	result, err := a.qrySvc.Execute(a.ctx, sql)
	return result, a.handleDBError(err)
}

// CancelQuery cancels the currently-executing user query.
// It signals the query context to cancel, which causes pgx to also send a
// PostgreSQL CancelRequest packet so the server stops processing the query.
func (a *App) CancelQuery() {
	if a.qrySvc != nil {
		a.qrySvc.Cancel()
	}
}

func (a *App) SaveQueryResultEdits(schema string, table string, updates []models.RowUpdate) error {
	if !a.IsConnected() {
		return errors.New("not connected")
	}
	err := a.qrySvc.SaveQueryResultEdits(a.ctx, schema, table, updates)
	return a.handleDBError(err)
}

// InvalidateTableCache removes cached structure metadata for a single table.
// Call this after DDL that modifies the table (ALTER TABLE, DROP TABLE, etc.)
// so the next TableStructure fetch reflects the new schema.
func (a *App) InvalidateTableCache(schema, table string) {
	if a.meta != nil {
		a.meta.InvalidateTableCache(schema, table)
	}
}

// ExportTablesCSV prompts the user with a save file dialog and exports selected tables to CSV (in a ZIP file).
func (a *App) ExportTablesCSV(schema string, tables []string) (string, error) {
	if !a.IsConnected() {
		return "", errors.New("not connected")
	}
	if len(tables) == 0 {
		return "", errors.New("no tables selected")
	}

	// Show Wails SaveFileDialog
	destPath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("%s_%s_export.zip", a.conn.Cfg.Database, schema),
		Title:           "Export CSVs to ZIP",
		Filters: []runtime.FileFilter{
			{DisplayName: "ZIP Files (*.zip)", Pattern: "*.zip"},
		},
	})
	if err != nil {
		return "", err
	}
	if destPath == "" {
		return "", nil // user cancelled
	}

	err = a.expSvc.ExportCSV(a.ctx, schema, tables, destPath)
	if err != nil {
		return "", a.handleDBError(err)
	}

	return destPath, nil
}

// BackupTablesSQL prompts the user with a save file dialog and backs up selected tables to SQL.
func (a *App) BackupTablesSQL(schema string, tables []string) (string, error) {
	if !a.IsConnected() {
		return "", errors.New("not connected")
	}
	if len(tables) == 0 {
		return "", errors.New("no tables selected")
	}

	// Show Wails SaveFileDialog
	destPath, err := runtime.SaveFileDialog(a.ctx, runtime.SaveDialogOptions{
		DefaultFilename: fmt.Sprintf("%s_%s_backup.sql", a.conn.Cfg.Database, schema),
		Title:           "Backup Tables to SQL",
		Filters: []runtime.FileFilter{
			{DisplayName: "SQL Files (*.sql)", Pattern: "*.sql"},
		},
	})
	if err != nil {
		return "", err
	}
	if destPath == "" {
		return "", nil // user cancelled
	}

	err = a.expSvc.BackupSQL(a.ctx, schema, tables, destPath)
	if err != nil {
		return "", a.handleDBError(err)
	}

	return destPath, nil
}
