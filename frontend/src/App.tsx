import CodeMirror from '@uiw/react-codemirror';
import { sql } from '@codemirror/lang-sql';
import { keymap } from '@codemirror/view';
import { githubLight, githubDark } from '@uiw/codemirror-theme-github';
import { type MouseEvent, type PointerEvent, useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  CancelQuery,
  Connect,
  Disconnect,
  ExecuteQuery,
  GetCellValue,
  GetFilteredTableData,
  GetTableData,
  GetTableStructure,
  InvalidateTableCache,
  IsConnected,
  ListDatabases,
  ListObjects,
  ListSchemas,
  SaveQueryResultEdits,
  TestConnection,
} from '../wailsjs/go/main/App';

export type ThemeMode = 'system' | 'light' | 'dark';

export interface AppSettings {
  theme: ThemeMode;
  appFont: string;
  editorFont: string;
  tableFont: string;
}

export const APP_FONT_PRESETS = [
  { label: 'Roboto (Default)', value: 'Roboto', stack: 'Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'System Default', value: 'System', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif' },
  { label: 'Inter', value: 'Inter', stack: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'Segoe UI', value: 'Segoe UI', stack: '"Segoe UI", Tahoma, Geneva, Verdana, sans-serif' },
  { label: 'San Francisco / Helvetica', value: 'San Francisco', stack: '-apple-system, "Helvetica Neue", Helvetica, Arial, sans-serif' },
  { label: 'Open Sans', value: 'Open Sans', stack: '"Open Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'Nunito', value: 'Nunito', stack: 'Nunito, -apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Ubuntu', value: 'Ubuntu', stack: 'Ubuntu, -apple-system, BlinkMacSystemFont, sans-serif' },
  { label: 'Custom…', value: 'custom', stack: '' },
];

export const EDITOR_FONT_PRESETS = [
  { label: 'Source Code Pro (Default)', value: 'Source Code Pro', stack: '"Source Code Pro", SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace' },
  { label: 'Fira Code', value: 'Fira Code', stack: '"Fira Code", "Source Code Pro", monospace' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono', stack: '"JetBrains Mono", "Source Code Pro", monospace' },
  { label: 'Consolas', value: 'Consolas', stack: 'Consolas, Monaco, "Courier New", monospace' },
  { label: 'Menlo', value: 'Menlo', stack: 'Menlo, Monaco, "Courier New", monospace' },
  { label: 'Monaco', value: 'Monaco', stack: 'Monaco, Menlo, "Courier New", monospace' },
  { label: 'Courier New', value: 'Courier New', stack: '"Courier New", Courier, monospace' },
  { label: 'System Monospace', value: 'System Monospace', stack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace' },
  { label: 'Custom…', value: 'custom', stack: '' },
];

export const TABLE_FONT_PRESETS = [
  { label: 'Source Code Pro (Default)', value: 'Source Code Pro', stack: '"Source Code Pro", SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
  { label: 'Roboto', value: 'Roboto', stack: 'Roboto, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'System Sans-Serif', value: 'System Sans-Serif', stack: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif' },
  { label: 'System Monospace', value: 'System Monospace', stack: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace' },
  { label: 'Inter', value: 'Inter', stack: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif' },
  { label: 'Fira Code', value: 'Fira Code', stack: '"Fira Code", monospace' },
  { label: 'JetBrains Mono', value: 'JetBrains Mono', stack: '"JetBrains Mono", monospace' },
  { label: 'Consolas', value: 'Consolas', stack: 'Consolas, Monaco, monospace' },
  { label: 'Menlo', value: 'Menlo', stack: 'Menlo, Monaco, monospace' },
  { label: 'Courier New', value: 'Courier New', stack: '"Courier New", monospace' },
  { label: 'Custom…', value: 'custom', stack: '' },
];

const defaultSettings: AppSettings = {
  theme: 'system',
  appFont: 'Roboto',
  editorFont: 'Source Code Pro',
  tableFont: 'Source Code Pro',
};

const resolveFontFamily = (fontValue: string, type: 'app' | 'editor' | 'table'): string => {
  const presets = type === 'app' ? APP_FONT_PRESETS : type === 'editor' ? EDITOR_FONT_PRESETS : TABLE_FONT_PRESETS;
  const match = presets.find((p) => p.value.toLowerCase() === fontValue.toLowerCase() && p.value !== 'custom');
  if (match && match.stack) return match.stack;
  if (!fontValue || fontValue.trim() === '' || fontValue === 'custom') {
    return presets[0].stack;
  }
  return `"${fontValue}", ${presets[0].stack}`;
};

type ConnectionConfig = {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  sslMode: string;
};

type SavedConnection = Omit<ConnectionConfig, 'password'> & {
  id: string;
  password?: string;
};

type DatabaseObject = {
  name: string;
  type: string;
};

type ColumnInfo = {
  name: string;
  type: string;
  nullable: boolean;
  default: string;
  isGenerated: boolean;
  isIdentity: boolean;
  isPrimaryKey: boolean;
  isForeignKey: boolean;
  isUnique: boolean;
  comment: string;
};

type DataPage = {
  columns: string[];
  rows: Record<string, unknown>[];
  totalRows: number;
  hasNextPage: boolean;
  page: number;
  pageSize: number;
  primaryKey?: string;
};

type QueryResult = {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  executionMs: number;
  success: boolean;
  message: string;
  /** Column names where at least one value was server-side truncated. */
  truncatedColumns?: string[];
};

type EditableResultTarget = {
  schema: string;
  table: string;
  primaryKey: string[];
};

type PendingResultEdits = Record<number, Record<string, unknown>>;

type WorkspaceType = 'table-data' | 'table-structure' | 'sql-editor';

type TableLookupOperator = '=' | '<>' | '>' | '>=' | '<' | '<=' | 'LIKE' | 'ILIKE' | 'NOT LIKE' | 'NOT ILIKE' | 'IS NULL' | 'IS NOT NULL';

type TableLookupFilter = {
  column: string;
  operator: TableLookupOperator;
  value: string;
};

type TableDataWorkspace = {
  id: string;
  type: 'table-data';
  title: string;
  schema: string;
  table: string;
  data: DataPage | null;
  structure: ColumnInfo[];
  loading: boolean;
  lookupColumn: string;
  lookupOperator: TableLookupOperator;
  lookupValue: string;
  lookupFilter: TableLookupFilter | null;
};

type TableStructureWorkspace = {
  id: string;
  type: 'table-structure';
  title: string;
  schema: string;
  table: string;
  structure: ColumnInfo[];
  loading: boolean;
};

type SqlWorkspace = {
  id: string;
  type: 'sql-editor';
  title: string;
  schema: string;
  table?: string;
  query: string;
  queryResult: QueryResult | null;
  lastExecutedSql: string;
  queryResultTarget: EditableResultTarget | null;
  pendingResultEdits: PendingResultEdits;
  editingResultCell: { row: number; column: string; value: string } | null;
  resultHeight: number;
  isSavingResultEdits: boolean;
  isRunning: boolean;
  resultFilterColumn: string;
  resultFilterOperator: TableLookupOperator;
  resultFilterValue: string;
  resultFilterActive: string;
};

type WorkspaceItem = TableDataWorkspace | TableStructureWorkspace | SqlWorkspace;

const objectGroups = [
  { type: 'table', label: 'Tables' },
  { type: 'index', label: 'Indexes' },
  { type: 'view', label: 'Views' },
  { type: 'materialized_view', label: 'Materialized Views' },
] as const;

const objectNameCollator = new Intl.Collator(undefined, { sensitivity: 'base', numeric: true });

const defaultConfig: ConnectionConfig = {
  name: 'Local PostgreSQL',
  host: 'localhost',
  port: 5432,
  database: 'mydb',
  username: 'postgres',
  password: '',
  // Default to "disable" — matches pgAdmin behaviour and works reliably
  // with port-forwarded / kubectl-tunnelled PostgreSQL instances.
  sslMode: 'disable',
};

const toNullLabel = (value: unknown): string => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
};

const quoteIdentifier = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

const quoteLiteral = (value: string) => {
  let tagName = 'querybird';
  let suffix = 0;
  while (value.includes(`$${tagName}$`)) tagName = `querybird_${++suffix}`;
  const tag = `$${tagName}$`;
  return `${tag}${value}${tag}`;
};

const parseEditableResultTarget = (sqlText: string, fallbackSchema: string): { schema: string; table: string } | null => {
  const match = sqlText.trim().match(
    /^SELECT\s+\*\s+FROM\s+(?:(?:"((?:""|[^"])*)"|([A-Za-z_][\w$]*))\s*\.\s*)?(?:"((?:""|[^"])*)"|([A-Za-z_][\w$]*))(?:\s+(?:WHERE|ORDER\s+BY|LIMIT|OFFSET|FETCH|FOR)\b[\s\S]*)?\s*;?$/i,
  );
  if (!match) return null;
  const unquote = (value: string) => value.replaceAll('""', '"');
  return {
    schema: match[1] !== undefined ? unquote(match[1]) : match[2] ?? fallbackSchema,
    table: match[3] !== undefined ? unquote(match[3]) : match[4],
  };
};

const buildSavedConnection = (cfg: ConnectionConfig | SavedConnection, existingId?: string | null): SavedConnection => ({
  id: existingId ?? `conn-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
  name: cfg.name || cfg.database || cfg.host || 'Local PostgreSQL',
  host: cfg.host,
  port: cfg.port,
  database: cfg.database,
  username: cfg.username,
  password: cfg.password ?? '',
  sslMode: cfg.sslMode,
});

function App() {
  const [config, setConfig] = useState<ConnectionConfig>(defaultConfig);
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [connectionState, setConnectionState] = useState<{ name?: string; database: string; host: string; username: string; port: number } | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const [status, setStatus] = useState('Disconnected');
  const [error, setError] = useState('');
  const [flashMessage, setFlashMessage] = useState('');
  const [flashKey, setFlashKey] = useState(0);
  const [isConnecting, setIsConnecting] = useState(false);
  const [databaseNames, setDatabaseNames] = useState<string[]>([]);
  const [schemas, setSchemas] = useState<string[]>([]);
  const [selectedSchema, setSelectedSchema] = useState('public');
  const [objects, setObjects] = useState<DatabaseObject[]>([]);
  const [selectedObject, setSelectedObject] = useState<DatabaseObject | null>(null);
  const [savedQueries, setSavedQueries] = useState<string[]>([]);
  const [objectFilter, setObjectFilter] = useState('');
  const [workspaces, setWorkspaces] = useState<WorkspaceItem[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; table: DatabaseObject } | null>(null);
  const [dropTableTarget, setDropTableTarget] = useState<{ schema: string; table: string } | null>(null);
  const [isConnectionDialogOpen, setIsConnectionDialogOpen] = useState(false);
  const [connectionDialogMode, setConnectionDialogMode] = useState<'new' | 'edit'>('new');
  const [connectionDialogId, setConnectionDialogId] = useState<string | null>(null);
  const [connectionDialogConfig, setConnectionDialogConfig] = useState<ConnectionConfig>(defaultConfig);
  const [settings, setSettings] = useState<AppSettings>(() => {
    try {
      const stored = window.localStorage.getItem('querybird-settings');
      if (stored) return { ...defaultSettings, ...JSON.parse(stored) };
    } catch {}
    return defaultSettings;
  });
  const [isSettingsDialogOpen, setIsSettingsDialogOpen] = useState(false);
  const [customAppFontInput, setCustomAppFontInput] = useState('');
  const [customEditorFontInput, setCustomEditorFontInput] = useState('');
  const [customTableFontInput, setCustomTableFontInput] = useState('');

  const [activeMainMenu, setActiveMainMenu] = useState<'connection' | 'settings' | 'help' | null>(null);
  const [isAboutDialogOpen, setIsAboutDialogOpen] = useState(false);
  const [pendingDeleteConnection, setPendingDeleteConnection] = useState<SavedConnection | null>(null);
  const [cellModal, setCellModal] = useState<{
    schema: string; table: string; pkColumn: string; pkValue: string;
    column: string; preview: string; full: string | null; loading: boolean;
  } | null>(null);
  const [savedVisibleTables, setSavedVisibleTables] = useState<Record<string, string[]>>({});
  const [isTableConfigDialogOpen, setIsTableConfigDialogOpen] = useState(false);
  const [tableConfigSearch, setTableConfigSearch] = useState('');
  const [selectedTableNames, setSelectedTableNames] = useState<string[]>([]);
  const sqlEditorViewRefs = useRef<Record<string, import('@codemirror/view').EditorView | null>>({});

  const [systemPrefersDark, setSystemPrefersDark] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)').matches : false
  );

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = (e: MediaQueryListEvent) => {
      setSystemPrefersDark(e.matches);
    };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  const effectiveTheme: 'dark' | 'light' =
    settings.theme === 'system'
      ? (systemPrefersDark ? 'dark' : 'light')
      : settings.theme;

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    document.documentElement.style.setProperty('--font-family-ui', resolveFontFamily(settings.appFont, 'app'));
    document.documentElement.style.setProperty('--font-family-editor', resolveFontFamily(settings.editorFont, 'editor'));
    document.documentElement.style.setProperty('--font-family-table', resolveFontFamily(settings.tableFont, 'table'));
  }, [effectiveTheme, settings.appFont, settings.editorFont, settings.tableFont]);

  const updateSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    window.localStorage.setItem('querybird-settings', JSON.stringify(newSettings));
  };

  const openSettingsDialog = () => {
    const isAppPreset = APP_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.appFont.toLowerCase());
    const isEditorPreset = EDITOR_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.editorFont.toLowerCase());
    const isTablePreset = TABLE_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.tableFont.toLowerCase());

    setCustomAppFontInput(isAppPreset ? '' : settings.appFont);
    setCustomEditorFontInput(isEditorPreset ? '' : settings.editorFont);
    setCustomTableFontInput(isTablePreset ? '' : settings.tableFont);
    setIsSettingsDialogOpen(true);
  };

  const activeWorkspace = useMemo(() => {
    if (!workspaces.length) return null;
    return workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[workspaces.length - 1];
  }, [activeWorkspaceId, workspaces]);

  const showFlash = (msg: string) => {
    setFlashMessage(msg);
    setFlashKey((k) => k + 1);
    setTimeout(() => setFlashMessage(''), 2600);
  };

  const persistSavedConnections = (items: SavedConnection[]) => {
    const sanitized = items.map(({ password: _password, ...rest }) => rest) as SavedConnection[];
    window.localStorage.setItem('querybird-saved-connections', JSON.stringify(sanitized));
    window.localStorage.removeItem('dbclient-saved-connections');
    setSavedConnections(sanitized);
  };

  const persistSavedQueries = (items: string[]) => {
    window.localStorage.setItem('querybird-saved-queries', JSON.stringify(items));
    window.localStorage.removeItem('dbclient-saved-queries');
    setSavedQueries(items);
  };

  const persistVisibleTables = (items: Record<string, string[]>) => {
    window.localStorage.setItem('querybird-visible-tables', JSON.stringify(items));
    setSavedVisibleTables(items);
  };

  const updateWorkspace = (workspaceId: string, updates: Record<string, unknown>) => {
    setWorkspaces((current) => current.map((workspace) => (
      workspace.id === workspaceId ? ({ ...workspace, ...updates } as WorkspaceItem) : workspace
    )));
  };

  const openNewConnectionDialog = () => {
    setConnectionDialogMode('new');
    setConnectionDialogId(null);
    setConnectionDialogConfig({
      ...defaultConfig,
      host: config.host || defaultConfig.host,
      port: config.port || defaultConfig.port,
      database: config.database || defaultConfig.database,
      username: config.username || defaultConfig.username,
      sslMode: config.sslMode || defaultConfig.sslMode,
    });
    setIsConnectionDialogOpen(true);
  };

  const openEditConnectionDialog = (entry?: SavedConnection) => {
    const target = entry ?? buildSavedConnection({ ...defaultConfig, ...config }, connectionDialogId);
    setConnectionDialogMode('edit');
    setConnectionDialogId(target.id);
    setConnectionDialogConfig({
      name: target.name,
      host: target.host,
      port: target.port,
      database: target.database,
      username: target.username,
      password: target.password ?? '',
      sslMode: target.sslMode,
    });
    setIsConnectionDialogOpen(true);
  };

  const closeConnectionDialog = () => {
    setIsConnectionDialogOpen(false);
    setConnectionDialogId(null);
    setConnectionDialogConfig({ ...defaultConfig, ...config });
  };

  const saveConnectionToStorage = (entry: SavedConnection) => {
    const existing = savedConnections.filter((item) => item.id !== entry.id);
    const next = [entry, ...existing].sort((left, right) => left.name.localeCompare(right.name));
    persistSavedConnections(next);
  };

  const handleConnectionDialogSave = async () => {
    try {
      setError('');
      setStatus('Connecting...');
      setIsConnecting(true);
      const nextConfig = { ...connectionDialogConfig, name: connectionDialogConfig.name || connectionDialogConfig.database || 'Local PostgreSQL' };
      await TestConnection(nextConfig);
      const entry = buildSavedConnection(nextConfig, connectionDialogId);
      saveConnectionToStorage(entry);
      setConfig(nextConfig);
      setIsConnectionDialogOpen(false);
      setStatus('Connection ready');
      showFlash('✓ Connection saved');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
      setStatus('Connection test failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleTestConnection = async (nextConfig: ConnectionConfig) => {
    try {
      setError('');
      await TestConnection(nextConfig);
      setStatus('Connection test succeeded');
      showFlash('✓ Connection test passed');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection test failed');
      setStatus('Connection test failed');
    }
  };

  const handleDeleteSavedConnection = (entry: SavedConnection) => {
    setPendingDeleteConnection(entry);
  };

  const confirmDeleteSavedConnection = () => {
    if (!pendingDeleteConnection) return;
    const next = savedConnections.filter((item) => item.id !== pendingDeleteConnection.id);
    persistSavedConnections(next);
    setPendingDeleteConnection(null);
    setIsConnectionDialogOpen(false);
  };

  const handleSavedConnectionClick = (entry: SavedConnection) => {
    const hasMatchingConfig = config.host === entry.host
      && config.port === entry.port
      && config.database === entry.database
      && config.username === entry.username;
    const password = entry.password ?? (hasMatchingConfig ? config.password : '');
    if (!password) {
      openEditConnectionDialog(entry);
      return;
    }
    void handleConnect({ ...entry, password, sslMode: entry.sslMode ?? 'prefer' });
  };

  const handleReconnectSavedConnection = async (entry: SavedConnection) => {
    const hasMatchingConfig = config.host === entry.host
      && config.port === entry.port
      && config.database === entry.database
      && config.username === entry.username;
    const password = entry.password ?? (hasMatchingConfig ? config.password : '');
    if (!password) {
      openEditConnectionDialog(entry);
      return;
    }
    setActiveMainMenu(null);
    await handleConnect({ ...entry, password, sslMode: entry.sslMode ?? 'prefer' });
  };

  const loadSchemaObjects = async (schema: string) => {
    const objectsList = (await ListObjects(schema)) ?? [];
    setObjects(objectsList);
    if (!selectedObject || objectsList.every((obj) => obj.name !== selectedObject.name || obj.type !== selectedObject.type)) {
      const firstObject = objectsList.find((obj) => obj.type === 'table') ?? objectsList[0] ?? null;
      setSelectedObject(firstObject);
    }
    return objectsList;
  };

  const handleConnect = async (nextConfig: ConnectionConfig = config) => {
    try {
      setError('');
      setConnectionLost(false);
      setStatus('Connecting...');
      setIsConnecting(true);
      // Connect returns databases+schemas in one round-trip — no extra RPCs needed.
      const connection = await Connect(nextConfig);
      setConfig(nextConfig);
      setConnectionState({
        name: nextConfig.name,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
      });
      setStatus(`Connected to ${connection.database}`);
      const databases = connection.databases ?? [];
      setDatabaseNames(databases);
      const schemasList = connection.schemas ?? [];
      setSchemas(schemasList);
      const nextSchema = schemasList.includes('public') ? 'public' : schemasList[0] ?? 'public';
      setSelectedSchema(nextSchema);
      await loadSchemaObjects(nextSchema);
      const entry = buildSavedConnection(nextConfig, null);
      const deduped = [entry, ...savedConnections.filter((item) => !(item.host === entry.host && item.database === entry.database && item.username === entry.username))].slice(0, 8);
      setSavedConnections(deduped);
      persistSavedConnections(deduped);
      showFlash(`✓ Connected to ${connection.database}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
      setStatus('Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await Disconnect();
    setConnectionState(null);
    setConnectionLost(false);
    setStatus('Disconnected');
    setDatabaseNames([]);
    setSchemas([]);
    setObjects([]);
    setSelectedObject(null);
    setWorkspaces([]);
    setActiveWorkspaceId(null);
    setError('');
  };

  // handleReconnect re-uses the saved config to create a new connection without
  // clearing workspaces or the sidebar — the user picks up where they left off.
  const handleReconnect = async () => {
    if (!config.host) return;
    try {
      setError('');
      setIsConnecting(true);
      setConnectionLost(false);
      setStatus('Reconnecting...');
      const connection = await Connect(config);
      setConnectionState({
        name: config.name,
        host: connection.host,
        port: connection.port,
        database: connection.database,
        username: connection.username,
      });
      setStatus(`Connected to ${connection.database}`);
      const databases = connection.databases ?? [];
      setDatabaseNames(databases);
      const schemasList = connection.schemas ?? [];
      setSchemas(schemasList);
      // Refresh the object list for the current schema so the sidebar is up to date.
      const schemaToLoad = schemasList.includes(selectedSchema) ? selectedSchema : (schemasList[0] ?? 'public');
      setSelectedSchema(schemaToLoad);
      await loadSchemaObjects(schemaToLoad);
      showFlash(`✓ Reconnected to ${connection.database}`);
    } catch (err) {
      setConnectionLost(true);
      setError(err instanceof Error ? err.message : 'Reconnection failed. Check your connection settings.');
      setStatus('Connection failed');
    } finally {
      setIsConnecting(false);
    }
  };

  const handleObjectSelect = (item: DatabaseObject) => {
    setSelectedObject(item);
    setContextMenu(null);
  };

  const handleObjectContextMenu = (event: MouseEvent<HTMLButtonElement>, item: DatabaseObject) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedObject(item);
    setContextMenu({ x: event.clientX, y: event.clientY, table: item });
  };

  const closeWorkspace = (workspaceId: string) => {
    setWorkspaces((current) => {
      const next = current.filter((workspace) => workspace.id !== workspaceId);
      if (activeWorkspaceId === workspaceId) {
        setActiveWorkspaceId(next.length > 0 ? next[next.length - 1].id : null);
      }
      return next;
    });
    setContextMenu(null);
  };

  const openTableDataWorkspace = async (schema: string, table: DatabaseObject) => {
    const id = `table-data-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const workspace: TableDataWorkspace = {
      id,
      type: 'table-data',
      title: table.name,
      schema,
      table: table.name,
      data: null,
      structure: [],
      loading: true,
      lookupColumn: '',
      lookupOperator: '=',
      lookupValue: '',
      lookupFilter: null,
    };
    setWorkspaces((current) => [...current, workspace as WorkspaceItem]);
    setActiveWorkspaceId(id);
    setContextMenu(null);
    try {
      // Load data first so the table rows appear immediately.
      // Structure (column types, PK markers) is fetched afterwards — it is
      // cached server-side so subsequent opens are instant.
      // A single pgx.Conn can only run one query at a time so we must sequence.
      const data = await GetTableData(schema, table.name, 1, 50, '', 'DESC');
      updateWorkspace(id, { data, loading: false });
      // Background: fetch structure (cached after first load, very fast on repeat opens).
      try {
        const structure = await GetTableStructure(schema, table.name);
        updateWorkspace(id, { structure });
      } catch {
        // Structure is cosmetic (column types, PK icon) — data is already shown.
      }
    } catch (err) {
      updateWorkspace(id, { loading: false });
      setError(err instanceof Error ? err.message : 'Could not load table data');
    }
  };

  const loadTableDataPage = async (workspaceId: string, schema: string, table: string, page: number, pageSize: number, filter: TableLookupFilter | null = null) => {
    updateWorkspace(workspaceId, { loading: true });
    try {
      let data: DataPage;
      if (filter) {
        // Use the server-side filtered API: the WHERE clause executes in PostgreSQL,
        // no client-side COUNT(*) round-trip, no full table scan.
        data = await GetFilteredTableData(schema, table, page, pageSize, '', 'ASC', filter);
      } else {
        data = await GetTableData(schema, table, page, pageSize, '', 'ASC');
      }
      updateWorkspace(workspaceId, { data, loading: false });
    } catch (err) {
      updateWorkspace(workspaceId, { loading: false });
      setError(err instanceof Error ? err.message : 'Could not load table data');
    }
  };

  const applyTableLookup = (workspace: TableDataWorkspace) => {
    const column = workspace.lookupColumn || workspace.data?.columns[0] || '';
    if (!column) return;
    const filter: TableLookupFilter = {
      column,
      operator: workspace.lookupOperator,
      value: workspace.lookupValue,
    };
    if (filter.operator !== 'IS NULL' && filter.operator !== 'IS NOT NULL' && !filter.value.trim()) {
      setError('Enter a value for the selected lookup operator.');
      return;
    }
    setError('');
    updateWorkspace(workspace.id, { lookupColumn: column, lookupFilter: filter });
    void loadTableDataPage(workspace.id, workspace.schema, workspace.table, 1, workspace.data?.pageSize ?? 25, filter);
  };

  const clearTableLookup = (workspace: TableDataWorkspace) => {
    updateWorkspace(workspace.id, { lookupFilter: null, lookupValue: '' });
    void loadTableDataPage(workspace.id, workspace.schema, workspace.table, 1, workspace.data?.pageSize ?? 25);
  };

  const openTableStructureWorkspace = async (schema: string, table: DatabaseObject) => {
    const id = `table-structure-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const workspace: TableStructureWorkspace = {
      id,
      type: 'table-structure',
      title: `Structure: ${table.name}`,
      schema,
      table: table.name,
      structure: [],
      loading: true,
    };
    setWorkspaces((current) => [...current, workspace as WorkspaceItem]);
    setActiveWorkspaceId(id);
    setContextMenu(null);
    try {
      const structure = await GetTableStructure(schema, table.name);
      updateWorkspace(id, { structure, loading: false });
    } catch (err) {
      updateWorkspace(id, { loading: false });
      setError(err instanceof Error ? err.message : 'Could not load table structure');
    }
  };

  const openSqlEditorWorkspace = (initialQuery = '', schema?: string, table?: string) => {
    const sqlTabs = workspaces.filter((workspace) => workspace.type === 'sql-editor');
    const id = `sql-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const workspace: SqlWorkspace = {
      id,
      type: 'sql-editor',
      title: `Query #${sqlTabs.length + 1}`,
      schema: schema ?? selectedSchema,
      table,
      query: initialQuery,
      queryResult: null,
      lastExecutedSql: '',
      queryResultTarget: null,
      pendingResultEdits: {},
      editingResultCell: null,
      resultHeight: 230,
      isSavingResultEdits: false,
      isRunning: false,
      resultFilterColumn: '',
      resultFilterOperator: '=',
      resultFilterValue: '',
      resultFilterActive: '',
    };
    setWorkspaces((current) => [...current, workspace as WorkspaceItem]);
    setActiveWorkspaceId(id);
    setContextMenu(null);
  };

  const currentDbSchemaKey = connectionState
    ? `${connectionState.host}:${connectionState.port}/${connectionState.database}/${selectedSchema}`
    : '';

  const configuredVisibleTables = useMemo(() => {
    if (!currentDbSchemaKey) return null;
    if (savedVisibleTables[currentDbSchemaKey] !== undefined) {
      return savedVisibleTables[currentDbSchemaKey];
    }
    const fallbackKey = connectionState ? `${connectionState.database}/${selectedSchema}` : '';
    if (fallbackKey && savedVisibleTables[fallbackKey] !== undefined) {
      return savedVisibleTables[fallbackKey];
    }
    return null;
  }, [currentDbSchemaKey, savedVisibleTables, connectionState, selectedSchema]);

  const allSchemaTables = useMemo(() => (
    objects.filter((obj) => obj.type === 'table')
  ), [objects]);

  const visibleObjects = useMemo(() => {
    if (!configuredVisibleTables) return objects;
    const visibleSet = new Set(configuredVisibleTables);
    return objects.filter((object) => object.type !== 'table' || visibleSet.has(object.name));
  }, [objects, configuredVisibleTables]);

  const filteredObjects = useMemo(() => (
    visibleObjects.filter((object) => object.name.toLocaleLowerCase().includes(objectFilter.trim().toLocaleLowerCase()))
  ), [visibleObjects, objectFilter]);

  const groupedObjects = useMemo(() => objectGroups.map((group) => ({
    ...group,
    objects: filteredObjects
      .filter((object) => object.type === group.type)
      .sort((left, right) => objectNameCollator.compare(left.name ?? '', right.name ?? '')),
  })), [filteredObjects]);

  const openTableConfigDialog = () => {
    const tableNames = objects.filter((obj) => obj.type === 'table').map((obj) => obj.name);
    if (configuredVisibleTables) {
      setSelectedTableNames(configuredVisibleTables.filter((name) => tableNames.includes(name)));
    } else {
      setSelectedTableNames([...tableNames]);
    }
    setTableConfigSearch('');
    setIsTableConfigDialogOpen(true);
  };

  const toggleTableSelection = (tableName: string) => {
    setSelectedTableNames((current) => (
      current.includes(tableName)
        ? current.filter((name) => name !== tableName)
        : [...current, tableName]
    ));
  };

  const selectAllTables = () => {
    const matching = allSchemaTables
      .map((t) => t.name)
      .filter((name) => name.toLowerCase().includes(tableConfigSearch.trim().toLowerCase()));
    setSelectedTableNames((current) => Array.from(new Set([...current, ...matching])));
  };

  const deselectAllTables = () => {
    if (tableConfigSearch.trim()) {
      const matchingSet = new Set(
        allSchemaTables
          .map((t) => t.name)
          .filter((name) => name.toLowerCase().includes(tableConfigSearch.trim().toLowerCase()))
      );
      setSelectedTableNames((current) => current.filter((name) => !matchingSet.has(name)));
    } else {
      setSelectedTableNames([]);
    }
  };

  const handleSaveTableConfig = () => {
    if (!currentDbSchemaKey) return;
    const next = { ...savedVisibleTables, [currentDbSchemaKey]: selectedTableNames };
    persistVisibleTables(next);
    setIsTableConfigDialogOpen(false);
    showFlash(`✓ Visible tables updated (${selectedTableNames.length} of ${allSchemaTables.length} visible)`);
  };

  const handleResetTableConfig = () => {
    if (!currentDbSchemaKey) return;
    const next = { ...savedVisibleTables };
    delete next[currentDbSchemaKey];
    const fallbackKey = connectionState ? `${connectionState.database}/${selectedSchema}` : '';
    if (fallbackKey) delete next[fallbackKey];
    persistVisibleTables(next);
    setIsTableConfigDialogOpen(false);
    showFlash('✓ Showing all tables');
  };

  const runSqlWorkspaceText = async (workspaceId: string, sqlText: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.type !== 'sql-editor') return;
    try {
      if (!sqlText.trim()) return;
      setError('');
      updateWorkspace(workspaceId, { isRunning: true });
      const result = await ExecuteQuery(sqlText);
      updateWorkspace(workspaceId, {
        queryResult: result,
        lastExecutedSql: sqlText,
        pendingResultEdits: {},
        editingResultCell: null,
        queryResultTarget: null,
        isRunning: false,
      });
      const source = parseEditableResultTarget(sqlText, workspace.schema ?? selectedSchema);
      if (source) {
        try {
          const columns = await GetTableStructure(source.schema, source.table);
          const primaryKey = columns.filter((column) => column.isPrimaryKey).map((column) => column.name);
          if (primaryKey.length > 0 && primaryKey.every((column) => result.columns.includes(column))) {
            updateWorkspace(workspaceId, { queryResultTarget: { ...source, primaryKey } });
          }
        } catch (err) {
          setError(`Query succeeded, but result editing metadata could not be loaded: ${err instanceof Error ? err.message : 'metadata request failed'}`);
        }
      }
      setActiveWorkspaceId(workspaceId);
    } catch (err) {
      updateWorkspace(workspaceId, { isRunning: false });
      setError(err instanceof Error ? err.message : 'Query failed');
    }
  };

  const handleRunQuery = (workspaceId: string) => {
    const target = workspaces.find((item) => item.id === workspaceId);
    if (!target || target.type !== 'sql-editor') return;
    void runSqlWorkspaceText(workspaceId, target.query ?? '');
  };

  const handleRunSelection = (workspaceId: string, selectedSql: string) => {
    void runSqlWorkspaceText(workspaceId, selectedSql);
  };

  const handleCommitCellEdit = (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.type !== 'sql-editor' || !workspace.editingResultCell || !workspace.queryResult) return;
    const { row, column, value } = workspace.editingResultCell;
    const originalValue = workspace.queryResult.rows[row]?.[column];
    const originalDisplay = originalValue === null || originalValue === undefined ? 'NULL' : toNullLabel(originalValue);
    const nextValue = value === originalDisplay ? originalValue : (value.trim().toUpperCase() === 'NULL' ? null : value);
    const pending = { ...(workspace.pendingResultEdits ?? {}) };
    const rowEdits = { ...(pending[row] ?? {}) };
    if (Object.is(nextValue, originalValue)) {
      delete rowEdits[column];
    } else {
      rowEdits[column] = nextValue;
    }
    const nextPending = { ...pending };
    if (Object.keys(rowEdits).length === 0) delete nextPending[row];
    else nextPending[row] = rowEdits;
    updateWorkspace(workspaceId, { pendingResultEdits: nextPending, editingResultCell: null });
  };

  const handleSaveResultEdits = async (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.type !== 'sql-editor' || !workspace.queryResultTarget || !workspace.queryResult || Object.keys(workspace.pendingResultEdits ?? {}).length === 0) return;
    try {
      updateWorkspace(workspaceId, { isSavingResultEdits: true });
      setError('');
      const updates = Object.entries(workspace.pendingResultEdits ?? {}).map(([rowIndex, values]) => {
        const row = workspace.queryResult!.rows[Number(rowIndex)];
        const keys: Record<string, unknown> = {};
        for (const key of workspace.queryResultTarget!.primaryKey) keys[key] = row[key];
        return { keys, values };
      });
      await SaveQueryResultEdits(workspace.queryResultTarget.schema, workspace.queryResultTarget.table, updates);
      showFlash(`✓ ${Object.keys(workspace.pendingResultEdits).length} row(s) saved`);
      void runSqlWorkspaceText(workspaceId, workspace.lastExecutedSql ?? '');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save result edits');
    } finally {
      updateWorkspace(workspaceId, { isSavingResultEdits: false });
    }
  };

  const handleResultDividerPointerDown = (workspaceId: string, event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handleResultDividerPointerMove = (workspaceId: string, event: PointerEvent<HTMLDivElement>) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (workspace?.type !== 'sql-editor') return;
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
    if (!bounds) return;
    const maxHeight = Math.max(120, bounds.height - 170);
    const nextHeight = Math.max(120, Math.min(bounds.bottom - event.clientY, maxHeight));
    updateWorkspace(workspaceId, { resultHeight: nextHeight });
  };

  const handleEditorSelectionRun = (workspaceId: string, view: import('@codemirror/view').EditorView) => {
    const selection = view.state.selection.main;
    if (selection.empty) return false;
    void handleRunSelection(workspaceId, view.state.sliceDoc(selection.from, selection.to));
    return true;
  };

  const saveCurrentQuery = (workspaceId: string) => {
    const workspace = workspaces.find((item) => item.id === workspaceId);
    if (!workspace || workspace.type !== 'sql-editor' || !workspace.query.trim()) return;
    const next = [workspace.query, ...savedQueries.filter((entry) => entry !== workspace.query)].slice(0, 10);
    persistSavedQueries(next);
    showFlash('✓ Query saved');
  };

  const deleteSavedQuery = (index: number) => {
    persistSavedQueries(savedQueries.filter((_, itemIndex) => itemIndex !== index));
  };

  const handleDropTable = async () => {
    if (!dropTableTarget) return;
    try {
      setError('');
      await ExecuteQuery(`DROP TABLE ${quoteIdentifier(dropTableTarget.schema)}.${quoteIdentifier(dropTableTarget.table)};`);
      // Invalidate the structure cache so a re-created table isn't stale.
      void InvalidateTableCache(dropTableTarget.schema, dropTableTarget.table);
      setStatus(`Dropped ${dropTableTarget.schema}.${dropTableTarget.table}`);
      setDropTableTarget(null);
      if (connectionState) {
        await loadSchemaObjects(selectedSchema);
      }
      setWorkspaces((current) => current.filter((workspace) => {
        if (workspace.type === 'table-data' || workspace.type === 'table-structure') {
          return workspace.table !== dropTableTarget.table || workspace.schema !== dropTableTarget.schema;
        }
        return true;
      }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not drop table');
    }
  };

  useEffect(() => {
    const storedConnections = window.localStorage.getItem('querybird-saved-connections') ?? window.localStorage.getItem('dbclient-saved-connections');
    if (storedConnections) {
      try {
        setSavedConnections(JSON.parse(storedConnections) as SavedConnection[]);
      } catch {}
    }

    const storedQueries = window.localStorage.getItem('querybird-saved-queries') ?? window.localStorage.getItem('dbclient-saved-queries');
    if (storedQueries) {
      try {
        setSavedQueries(JSON.parse(storedQueries) as string[]);
      } catch {}
    }

    const storedVisibleTables = window.localStorage.getItem('querybird-visible-tables');
    if (storedVisibleTables) {
      try {
        setSavedVisibleTables(JSON.parse(storedVisibleTables) as Record<string, string[]>);
      } catch {}
    }
  }, []);

  useEffect(() => {
    const syncSchema = async () => {
      if (!connectionState || !selectedSchema) return;
      try {
        await loadSchemaObjects(selectedSchema);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load schema objects');
      }
    };
    void syncSchema();
  }, [connectionState, selectedSchema]);

  useEffect(() => {
    const onPointerDown = (event: Event) => {
      if (event.target instanceof Element && event.target.closest('.context-menu')) return;
      setContextMenu(null);
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, []);

  // Poll the backend every 5 s while we believe we are connected.
  // If IsConnected() returns false, the Go layer already detected a network loss
  // (e.g. kubectl port-forward teardown) and marked the connection dead.
  // We surface this to the user as a non-destructive "connection lost" banner.
  useEffect(() => {
    if (!connectionState) return;
    const interval = setInterval(async () => {
      try {
        const alive = await IsConnected();
        if (!alive && !connectionLost) {
          setConnectionLost(true);
          setConnectionState(null);
          setStatus('Connection lost');
          setError('Connection lost. Check your port-forward or tunnel and reconnect.');
        }
      } catch {
        // If the IPC itself fails the app is likely shutting down — ignore.
      }
    }, 5000);
    return () => clearInterval(interval);
  }, [connectionState, connectionLost]);

  // Set of "schema.table" strings that currently have an open workspace tab
  const openTableKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const ws of workspaces) {
      if (ws.type === 'table-data' || ws.type === 'table-structure') {
        keys.add(`${ws.schema}.${ws.table}`);
      }
    }
    return keys;
  }, [workspaces]);

  const renderDataWorkspace = (workspace: TableDataWorkspace) => {
    if (workspace.loading) {
      return <div className="empty-state"><span className="spinner" /></div>;
    }
    if (!workspace.data) {
      return <div className="empty-state">No data available</div>;
    }
    const selectedLookupColumn = workspace.lookupColumn || workspace.data.columns[0] || '';
    const lookupNeedsValue = workspace.lookupOperator !== 'IS NULL' && workspace.lookupOperator !== 'IS NOT NULL';
    // Use hasNextPage from the backend (fetches pageSize+1 rows to detect next page
    // without an additional COUNT(*) query — important for high-latency connections).
    const hasPrev = workspace.data.page > 1;
    const hasNext = workspace.data.hasNextPage;
    return (
      <div className="panel-card workspace-body">
        <div className="content-header simple-header">
          <div>
            <div className="breadcrumbs">
              <span>{workspace.schema}</span>
              <span className="breadcrumb-separator">/</span>
              <strong>{workspace.table}</strong>
            </div>
            <div className="content-caption">{workspace.data.totalRows.toLocaleString()} rows (est.)</div>
          </div>
          <div className="inline-actions">
            <label className="page-size-control">Rows
              <select
                value={workspace.data.pageSize}
                onChange={(event) => void loadTableDataPage(workspace.id, workspace.schema, workspace.table, 1, Number(event.target.value), workspace.lookupFilter)}
              >
                <option value={25}>25</option>
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={250}>250</option>
              </select>
            </label>
            <button
              className="toolbar-button"
              aria-label="Previous page"
              disabled={!hasPrev}
              onClick={() => void loadTableDataPage(workspace.id, workspace.schema, workspace.table, workspace.data!.page - 1, workspace.data!.pageSize, workspace.lookupFilter)}
            >‹</button>
            <span className="pager">Page {workspace.data.page}</span>
            <button
              className="toolbar-button"
              aria-label="Next page"
              disabled={!hasNext}
              onClick={() => void loadTableDataPage(workspace.id, workspace.schema, workspace.table, workspace.data!.page + 1, workspace.data!.pageSize, workspace.lookupFilter)}
            >›</button>
          </div>
        </div>
        <form className="table-lookup" onSubmit={(event) => { event.preventDefault(); applyTableLookup(workspace); }}>
          <select
            aria-label="Lookup column"
            value={selectedLookupColumn}
            onChange={(event) => updateWorkspace(workspace.id, { lookupColumn: event.target.value })}
          >
            {workspace.data.columns.map((column) => <option key={column} value={column}>{column}</option>)}
          </select>
          <select
            aria-label="Lookup operator"
            value={workspace.lookupOperator}
            onChange={(event) => updateWorkspace(workspace.id, { lookupOperator: event.target.value as TableLookupOperator })}
          >
            <option value="=">equals</option>
            <option value="&lt;&gt;">not equals</option>
            <option value="&gt;">greater than</option>
            <option value="&gt;=">greater than or equal</option>
            <option value="&lt;">less than</option>
            <option value="&lt;=">less than or equal</option>
            <option value="LIKE">LIKE</option>
            <option value="ILIKE">ILIKE</option>
            <option value="NOT LIKE">NOT LIKE</option>
            <option value="NOT ILIKE">NOT ILIKE</option>
            <option value="IS NULL">IS NULL</option>
            <option value="IS NOT NULL">IS NOT NULL</option>
          </select>
          <input
            aria-label="Lookup value"
            placeholder={lookupNeedsValue ? 'Enter value or pattern' : 'Not needed'}
            disabled={!lookupNeedsValue}
            value={workspace.lookupValue}
            onChange={(event) => updateWorkspace(workspace.id, { lookupValue: event.target.value })}
          />
          <button className="lookup-submit" type="submit" aria-label="Execute lookup" title="Execute lookup">
            <svg viewBox="0 0 20 20" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m12.5 12.5 4 4" />
            </svg>
          </button>
          {workspace.lookupFilter && <button className="lookup-clear" type="button" onClick={() => clearTableLookup(workspace)}>Clear</button>}
        </form>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {workspace.data.columns.map((column) => {
                  const colInfo = workspace.structure.find((item) => item.name === column);
                  return (
                    <th key={column}>
                      <span className="column-heading">
                        <span>{column}</span>
                        {colInfo?.isPrimaryKey && <span className="pk-icon" title="Primary key">⚿</span>}
                        <span className="column-type">{colInfo?.type ?? ''}</span>
                      </span>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {workspace.data.rows.map((row, rowIndex) => (
                <tr key={`${workspace.id}-${rowIndex}`}>
                  {workspace.data!.columns.map((column) => {
                    const raw = row[column];
                    const display = toNullLabel(raw);
                    const isNull = raw === null || raw === undefined;
                    const pkCol = workspace.data!.primaryKey ?? '';
                    const pkVal = pkCol ? toNullLabel(row[pkCol]) : '';
                    return (
                      <td
                        key={`${workspace.id}-${rowIndex}-${column}`}
                        title={display.length > 100 ? 'Click to view in modal' : undefined}
                        onClick={display.length > 100 ? () => {
                          setCellModal({ schema: workspace.schema, table: workspace.table, pkColumn: pkCol, pkValue: pkVal, column, preview: display, full: display, loading: false });
                        } : undefined}
                      >
                        {isNull ? <span className="null-label">NULL</span> : display}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const renderStructureWorkspace = (workspace: TableStructureWorkspace) => {
    if (workspace.loading) {
      return <div className="empty-state"><span className="spinner" /></div>;
    }
    const hasComments = workspace.structure.some((col) => col.comment);
    const BoolIcon = ({ value }: { value: boolean }) => value
      ? <span className="bool-yes" title="Yes">✓</span>
      : <span className="bool-no" title="No">—</span>;
    return (
      <div className="panel-card workspace-body">
        <div className="structure-breadcrumb">
          <span>{workspace.schema}</span>
          <span className="breadcrumb-separator">/</span>
          <strong>{workspace.table}</strong>
          <span className="muted" style={{ marginLeft: 'auto', fontSize: '10px' }}>{workspace.structure.length} columns</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Nullable</th>
                <th>Default</th>
                <th>PK</th>
                <th>FK</th>
                <th>Unique</th>
                {hasComments && <th>Comment</th>}
              </tr>
            </thead>
            <tbody>
              {workspace.structure.map((column) => (
                <tr key={`${workspace.id}-${column.name}`} className={column.isPrimaryKey ? 'structure-pk-row' : ''}>
                  <td>{column.name}</td>
                  <td>{column.type}</td>
                  <td><BoolIcon value={column.nullable} /></td>
                  <td>{column.default || '—'}</td>
                  <td><BoolIcon value={column.isPrimaryKey} /></td>
                  <td><BoolIcon value={column.isForeignKey} /></td>
                  <td><BoolIcon value={column.isUnique} /></td>
                  {hasComments && <td>{column.comment || ''}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  };

  const applyResultFilter = (workspace: SqlWorkspace) => {
    const col = workspace.resultFilterColumn || workspace.queryResult?.columns[0] || '';
    if (!col) return;
    updateWorkspace(workspace.id, { resultFilterActive: col + '\x00' + workspace.resultFilterOperator + '\x00' + workspace.resultFilterValue });
  };

  const clearResultFilter = (workspace: SqlWorkspace) => {
    updateWorkspace(workspace.id, { resultFilterActive: '', resultFilterValue: '' });
  };

  const getFilteredResultRows = (workspace: SqlWorkspace) => {
    const rows = workspace.queryResult?.rows ?? [];
    if (!workspace.resultFilterActive) return rows;
    const [col, op, val] = workspace.resultFilterActive.split('\x00');
    return rows.filter((row) => {
      const raw = row[col];
      const cellStr = raw === null || raw === undefined ? '' : String(raw);
      if (op === 'IS NULL') return raw === null || raw === undefined;
      if (op === 'IS NOT NULL') return raw !== null && raw !== undefined;
      const v = val ?? '';
      if (op === '=') return cellStr === v;
      if (op === '<>') return cellStr !== v;
      if (op === '>') return Number(cellStr) > Number(v);
      if (op === '>=') return Number(cellStr) >= Number(v);
      if (op === '<') return Number(cellStr) < Number(v);
      if (op === '<=') return Number(cellStr) <= Number(v);
      if (op === 'LIKE') return new RegExp('^' + v.replace(/%/g, '.*').replace(/_/g, '.') + '$').test(cellStr);
      if (op === 'ILIKE') return new RegExp('^' + v.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(cellStr);
      if (op === 'NOT LIKE') return !new RegExp('^' + v.replace(/%/g, '.*').replace(/_/g, '.') + '$').test(cellStr);
      if (op === 'NOT ILIKE') return !new RegExp('^' + v.replace(/%/g, '.*').replace(/_/g, '.') + '$', 'i').test(cellStr);
      return true;
    });
  };

  const renderSqlWorkspace = (workspace: SqlWorkspace) => {
    const editorExtensions = [
      sql(),
      keymap.of([{ key: 'Mod-Enter', run: (view) => handleEditorSelectionRun(workspace.id, view) }]),
    ];
    const resultFilterCol = workspace.resultFilterColumn || workspace.queryResult?.columns[0] || '';
    const resultFilterNeedsValue = workspace.resultFilterOperator !== 'IS NULL' && workspace.resultFilterOperator !== 'IS NOT NULL';
    const filteredResultRows = getFilteredResultRows(workspace);

    return (
      <div className="panel-card sql-panel" ref={(node) => { if (node) { /* no-op for ref */ } }}>
        <div className="editor-tools">
          <button
            className={`primary-button${workspace.isRunning ? ' connecting' : ''}`}
            disabled={workspace.isRunning}
            onClick={() => handleRunQuery(workspace.id)}
          >{workspace.isRunning ? 'Running…' : 'Run query'}</button>
          {workspace.isRunning && (
            <button
              className="toolbar-button cancel-button"
              onClick={() => void CancelQuery()}
              title="Cancel running query"
            >Cancel</button>
          )}
          <button
            className="toolbar-button"
            disabled={workspace.isRunning}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              const view = sqlEditorViewRefs.current[workspace.id];
              if (!view || view.state.selection.main.empty) {
                setError('Select a SQL statement in the editor to run only that selection.');
                return;
              }
              handleEditorSelectionRun(workspace.id, view);
            }}
          >Run Selection <kbd>⌘↵</kbd></button>
          <button className="toolbar-button" disabled={workspace.isRunning} onClick={() => saveCurrentQuery(workspace.id)}>Save query</button>
        </div>
        <div className="sql-editor-area">
          <CodeMirror
            value={workspace.query}
            height="100%"
            theme={effectiveTheme === 'dark' ? githubDark : githubLight}
            extensions={editorExtensions}
            onCreateEditor={(view) => { sqlEditorViewRefs.current[workspace.id] = view; }}
            onChange={(value) => updateWorkspace(workspace.id, { query: value })}
          />
        </div>
        {savedQueries.length > 0 && (
          <div className="saved-queries">
            {savedQueries.map((item, index) => (
              <div key={`${index}:${item}`} className="saved-sql-item">
                <button title={item} onClick={() => updateWorkspace(workspace.id, { query: item })}>{item.slice(0, 48)}</button>
                <button className="saved-query-delete" title="Delete saved query" aria-label={`Delete saved query ${index + 1}`} onClick={() => deleteSavedQuery(index)}>×</button>
              </div>
            ))}
          </div>
        )}
        <div
          className="result-divider"
          role="separator"
          aria-label="Resize query results panel"
          aria-orientation="horizontal"
          title="Drag to resize query results"
          onPointerDown={(event) => handleResultDividerPointerDown(workspace.id, event)}
          onPointerMove={(event) => handleResultDividerPointerMove(workspace.id, event)}
          onDoubleClick={() => updateWorkspace(workspace.id, { resultHeight: 230 })}
        />
        {workspace.queryResult ? (
          <div className="result-grid" style={{ height: workspace.resultHeight, flex: '0 0 auto' }}>
            <div className="result-header">
              <span>
                {workspace.resultFilterActive
                  ? `${filteredResultRows.length.toLocaleString()} of ${workspace.queryResult.rowCount.toLocaleString()} rows (filtered)`
                  : `${workspace.queryResult.rowCount.toLocaleString()} rows`}
                {' · '}
                {workspace.queryResult.message.startsWith('Completed in ')
                  ? workspace.queryResult.message
                  : `${workspace.queryResult.executionMs} ms`}
                {workspace.queryResultTarget
                  ? ` · ${workspace.queryResultTarget.schema}.${workspace.queryResultTarget.table} (editable)`
                  : workspace.lastExecutedSql
                    ? ` · ${workspace.lastExecutedSql.trim().slice(0, 60).replace(/\s+/g, ' ')}${workspace.lastExecutedSql.trim().length > 60 ? '…' : ''}`
                    : ''}
              </span>
              <span className="result-edit-actions">
                {workspace.queryResultTarget && (
                  <button className="toolbar-button" onClick={() => void handleSaveResultEdits(workspace.id)} disabled={Object.keys(workspace.pendingResultEdits).length === 0 || workspace.isSavingResultEdits}>
                    {workspace.isSavingResultEdits ? 'Saving…' : `Save Changes${Object.keys(workspace.pendingResultEdits).length ? ` (${Object.keys(workspace.pendingResultEdits).length})` : ''}`}
                  </button>
                )}
                {Object.keys(workspace.pendingResultEdits).length > 0 && (
                  <button className="toolbar-button" onClick={() => updateWorkspace(workspace.id, { pendingResultEdits: {}, editingResultCell: null })}>Revert</button>
                )}
              </span>
            </div>
            {workspace.queryResult.columns.length > 0 && (
              <form className="table-lookup result-filter" onSubmit={(e) => { e.preventDefault(); applyResultFilter(workspace); }}>
                <select
                  aria-label="Filter column"
                  value={resultFilterCol}
                  onChange={(e) => updateWorkspace(workspace.id, { resultFilterColumn: e.target.value })}
                >
                  {workspace.queryResult.columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
                <select
                  aria-label="Filter operator"
                  value={workspace.resultFilterOperator}
                  onChange={(e) => updateWorkspace(workspace.id, { resultFilterOperator: e.target.value as TableLookupOperator })}
                >
                  <option value="=">equals</option>
                  <option value="<>">not equals</option>
                  <option value=">">greater than</option>
                  <option value=">=">greater than or equal</option>
                  <option value="<">less than</option>
                  <option value="<=">less than or equal</option>
                  <option value="LIKE">LIKE</option>
                  <option value="ILIKE">ILIKE</option>
                  <option value="NOT LIKE">NOT LIKE</option>
                  <option value="NOT ILIKE">NOT ILIKE</option>
                  <option value="IS NULL">IS NULL</option>
                  <option value="IS NOT NULL">IS NOT NULL</option>
                </select>
                <input
                  aria-label="Filter value"
                  placeholder={resultFilterNeedsValue ? 'Filter value or pattern' : 'Not needed'}
                  disabled={!resultFilterNeedsValue}
                  value={workspace.resultFilterValue}
                  onChange={(e) => updateWorkspace(workspace.id, { resultFilterValue: e.target.value })}
                />
                <button className="lookup-submit" type="submit" aria-label="Apply filter" title="Apply filter">
                  <svg viewBox="0 0 20 20" aria-hidden="true">
                    <circle cx="8.5" cy="8.5" r="5.5" />
                    <path d="m12.5 12.5 4 4" />
                  </svg>
                </button>
                {workspace.resultFilterActive && (
                  <button className="lookup-clear" type="button" onClick={() => clearResultFilter(workspace)}>Clear</button>
                )}
              </form>
            )}
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    {workspace.queryResult.columns.map((column) => <th key={column}>{column}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {filteredResultRows.map((row, rowIndex) => (
                    <tr key={`${workspace.id}-${rowIndex}-${JSON.stringify(row)}`} className={workspace.pendingResultEdits[rowIndex] ? 'row-pending' : ''}>
                      {workspace.queryResult!.columns.map((column) => {
                        const displayValue = Object.hasOwn(workspace.pendingResultEdits[rowIndex] ?? {}, column)
                          ? workspace.pendingResultEdits[rowIndex][column]
                          : row[column];
                        const displayStr = toNullLabel(displayValue);
                        const isNull = displayValue === null || displayValue === undefined;
                        const pkCols = workspace.queryResultTarget?.primaryKey ?? [];
                        const pkCol = pkCols[0] ?? '';
                        const pkVal = pkCol ? toNullLabel(row[pkCol]) : '';
                        return (
                          <td
                            key={`${workspace.id}-${rowIndex}-${column}`}
                            className={[
                              workspace.queryResultTarget && !pkCols.includes(column) ? 'editable-result-cell' : '',
                            ].filter(Boolean).join(' ') || undefined}
                            title={
                              workspace.queryResultTarget
                                ? (pkCols.includes(column) ? 'Primary key column; editing is disabled' : 'Double-click to edit')
                                : (displayStr.length > 100 ? 'Click to view in modal' : undefined)
                            }
                            onClick={(!workspace.queryResultTarget && displayStr.length > 100) ? () => {
                              setCellModal({ schema: '', table: '', pkColumn: pkCol, pkValue: pkVal, column, preview: displayStr, full: displayStr, loading: false });
                            } : undefined}
                            onDoubleClick={() => {
                              if (!workspace.queryResultTarget || pkCols.includes(column)) return;
                              updateWorkspace(workspace.id, {
                                editingResultCell: {
                                  row: rowIndex,
                                  column,
                                  value: displayValue === null || displayValue === undefined ? 'NULL' : toNullLabel(displayValue),
                                },
                              });
                            }}
                          >
                            {workspace.editingResultCell?.row === rowIndex && workspace.editingResultCell.column === column ? (
                              <input
                                autoFocus
                                className="result-cell-editor"
                                value={workspace.editingResultCell.value}
                                onChange={(event) => updateWorkspace(workspace.id, {
                                  editingResultCell: { ...workspace.editingResultCell!, value: event.target.value },
                                })}
                                onBlur={() => {
                                  if (workspace.editingResultCell) {
                                    handleCommitCellEdit(workspace.id);
                                  }
                                }}
                                onKeyDown={(event) => {
                                  if (event.key === 'Enter') {
                                    event.preventDefault();
                                    handleCommitCellEdit(workspace.id);
                                  }
                                  if (event.key === 'Escape') {
                                    updateWorkspace(workspace.id, { editingResultCell: null });
                                  }
                                }}
                              />
                            ) : isNull
                              ? <span className="null-label">NULL</span>
                              : displayStr}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : <div className="result-empty" style={{ height: workspace.resultHeight }}>No query results yet</div>}
      </div>
    );
  };

  const connectionStatusText = connectionLost
    ? 'Connection lost'
    : connectionState
      ? `${connectionState.host}:${connectionState.port} / ${connectionState.database}`
      : status === 'Connection failed' || status === 'Connection test failed'
        ? 'Connection failed'
        : status === 'Connecting...' || status === 'Reconnecting...'
          ? status
          : 'No active connection';

  return (
    <div className="querybird-shell">
      <header className="app-header">
        <div className="brand-column">
          <img className="brand-mark" src="/querybird-mark.png" alt="" />
          <span className="brand">QueryBird</span>
          <nav className="main-menu" aria-label="Application menu">
            <div className="menu-group">
              <button className="menu-button" type="button" onClick={() => setActiveMainMenu((current) => current === 'connection' ? null : 'connection')}>Connection</button>
              {activeMainMenu === 'connection' && (
                <div className="menu-popover" role="menu">
                  <button className="menu-item" type="button" onClick={() => { openNewConnectionDialog(); setActiveMainMenu(null); }}>New Connection</button>
                  <button className="menu-item" type="button" disabled={!connectionState} onClick={() => { openTableConfigDialog(); setActiveMainMenu(null); }}>Select Visible Tables…</button>
                  <div className="menu-divider" />
                  <button className="menu-item" type="button" disabled={!connectionState} onClick={() => { void handleDisconnect(); setActiveMainMenu(null); }}>Disconnect</button>
                </div>
              )}
            </div>
            <div className="menu-group">
              <button className="menu-button" type="button" onClick={() => setActiveMainMenu((current) => current === 'settings' ? null : 'settings')}>Settings</button>
              {activeMainMenu === 'settings' && (
                <div className="menu-popover" role="menu">
                  <button className="menu-item" type="button" onClick={() => { openSettingsDialog(); setActiveMainMenu(null); }}>Preferences…</button>
                  <div className="menu-divider" />
                  <button className="menu-item" type="button" onClick={() => { updateSettings({ ...settings, theme: settings.theme === 'dark' ? 'light' : 'dark' }); setActiveMainMenu(null); }}>
                    Switch to {effectiveTheme === 'dark' ? 'Light' : 'Dark'} Theme
                  </button>
                </div>
              )}
            </div>
            <div className="menu-group">
              <button className="menu-button" type="button" onClick={() => setActiveMainMenu((current) => current === 'help' ? null : 'help')}>Help</button>
              {activeMainMenu === 'help' && (
                <div className="menu-popover" role="menu">
                  <button className="menu-item" type="button" onClick={() => { setIsAboutDialogOpen(true); setActiveMainMenu(null); }}>About QueryBird</button>
                </div>
              )}
            </div>
          </nav>
        </div>
        <div className="header-status" aria-live="polite">
          <span className={`status-indicator ${connectionState ? 'connected' : connectionLost ? 'lost' : ''}`} />
          <span className="connection-title">{connectionStatusText}</span>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <div className="sidebar-section compact">
            <div className="section-label">Saved Connections</div>
            {connectionState ? (
              /* Collapsed when connected — just an add button */
              <button className="new-connection-btn" onClick={openNewConnectionDialog}>＋ New Connection</button>
            ) : (
              <div className="saved-list">
                {savedConnections.length === 0
                  ? <div className="muted">No saved connections — use Connection &gt; New Connection</div>
                  : savedConnections.map((item) => (
                  <div key={item.id} className="saved-item-group">
                    <button className="saved-item" onClick={() => handleSavedConnectionClick(item)}>
                      <strong>{item.name}</strong>
                      <span className="muted" style={{ fontSize: '10px' }}>{item.host}:{item.port}</span>
                    </button>
                    <div className="saved-actions">
                      <button className="mini-button" onClick={() => openEditConnectionDialog(item)}>Edit</button>
                      <button className="mini-button" onClick={() => void handleReconnectSavedConnection(item)}>Reconnect</button>
                      <button className="mini-button danger" onClick={() => handleDeleteSavedConnection(item)}>Delete</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {connectionState && (
            <div className="explorer">
              <div className="explorer-title">DATABASE</div>
              <label className="sidebar-label" htmlFor="database-select">Database</label>
              <select id="database-select" className="sidebar-select" title={connectionState.database} value={connectionState.database} onChange={(event) => void handleConnect({ ...config, database: event.target.value })}>
                {databaseNames.map((database) => <option key={database} value={database}>{database}</option>)}
              </select>

              <label className="sidebar-label" htmlFor="schema-select">Schema</label>
              <select id="schema-select" className="sidebar-select" title={selectedSchema} value={selectedSchema} onChange={(event) => setSelectedSchema(event.target.value)}>
                {schemas.map((schema) => <option key={schema} value={schema}>{schema}</option>)}
              </select>

              <div className="object-filter-wrap">
                <input className="object-filter" aria-label="Filter database objects" placeholder="⌕ Filter objects..." value={objectFilter} onChange={(event) => setObjectFilter(event.target.value)} />
              </div>

              <div className="object-tree">
                {groupedObjects.map((group) => (
                  <details className="object-group" key={group.type} open={Boolean(objectFilter)}>
                    <summary>
                      <span>{group.label}</span>
                      <div className="group-summary-right">
                        {group.type === 'table' && (
                          <button
                            type="button"
                            className={`group-config-btn ${configuredVisibleTables ? 'active' : ''}`}
                            title={configuredVisibleTables ? `Custom table selection active (${group.objects.length} visible of ${allSchemaTables.length}) — Click to configure` : 'Select visible tables'}
                            aria-label="Select visible tables"
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              openTableConfigDialog();
                            }}
                          >
                            ⚙
                          </button>
                        )}
                        <span className="group-count">
                          {group.type === 'table' && configuredVisibleTables
                            ? `${group.objects.length}/${allSchemaTables.length}`
                            : group.objects.length}
                        </span>
                      </div>
                    </summary>
                    {group.objects.length > 0 ? group.objects.map((object) => (
                      <button
                        key={`${object.type}:${object.name}`}
                        className={`object-item ${selectedObject?.name === object.name && selectedObject?.type === object.type ? 'active' : ''}`}
                        title={object.name}
                        onClick={() => handleObjectSelect(object)}
                        onContextMenu={(event) => handleObjectContextMenu(event, object)}
                      >
                        <span className={`object-icon ${object.type}`} aria-hidden="true">
                          {object.type === 'table' ? '▤' : object.type === 'view' || object.type === 'materialized_view' ? '◇' : object.type === 'index' ? '⚿' : object.type === 'function' ? 'ƒ' : object.type === 'sequence' ? '☵' : '▤'}
                        </span>
                        <span className="object-name">{object.name}</span>
                        {openTableKeys.has(`${selectedSchema}.${object.name}`) && (
                          <span className="object-open-dot" title="Has open workspace" />
                        )}
                      </button>
                    )) : objectFilter ? (
                      <div className="group-empty">No matches</div>
                    ) : group.type === 'table' && configuredVisibleTables ? (
                      <div className="group-empty">
                        <span>No tables visible.</span>
                        <button type="button" className="group-empty-link" onClick={openTableConfigDialog}>
                          Configure tables
                        </button>
                      </div>
                    ) : null}
                  </details>
                ))}
                {filteredObjects.length === 0 && objects.length === 0 && <div className="group-empty">No objects in this schema</div>}
              </div>
            </div>
          )}
        </aside>

        <main className="main-panel">
          {connectionLost && (
            <div className="connection-lost-banner" role="alert">
              <span className="connection-lost-icon">⚡</span>
              <span className="connection-lost-text">
                Connection lost. Check your port-forward or tunnel, then reconnect.
              </span>
              <button
                className={`primary-button connection-lost-reconnect${isConnecting ? ' connecting' : ''}`}
                disabled={isConnecting}
                onClick={() => void handleReconnect()}
              >{isConnecting ? 'Reconnecting…' : 'Reconnect'}</button>
            </div>
          )}
          {!connectionLost && error ? (
            <div className="error-banner">
              <span className="error-banner-text">{error}</span>
              <button className="error-dismiss" aria-label="Dismiss error" onClick={() => setError('')}>×</button>
            </div>
          ) : null}
          {workspaces.length === 0 ? (
            <div className="workspace-empty-state">
              <div className="empty-state-hint">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <ellipse cx="12" cy="5" rx="9" ry="3" />
                  <path d="M3 5v4c0 1.66 4.03 3 9 3s9-1.34 9-3V5" />
                  <path d="M3 9v4c0 1.66 4.03 3 9 3s9-1.34 9-3V9" />
                  <path d="M3 13v4c0 1.66 4.03 3 9 3s9-1.34 9-3v-4" />
                </svg>
                <p>Select a table to view data, or open the SQL editor</p>
                {connectionState && (
                  <div className="empty-state-actions">
                    <button className="empty-state-btn" onClick={() => openSqlEditorWorkspace()}>Open SQL Editor</button>
                  </div>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="tab-row">
                {workspaces.map((workspace) => (
                  <div key={workspace.id} className={activeWorkspace?.id === workspace.id ? 'workspace-tab active' : 'workspace-tab'}>
                    <button className="tab-button" onClick={() => setActiveWorkspaceId(workspace.id)}>
                      <span className={`tab-icon ${workspace.type}`} aria-hidden="true">
                        {workspace.type === 'sql-editor' ? '‹›' : workspace.type === 'table-structure' ? '☷' : '▦'}
                      </span>
                      {workspace.title}
                    </button>
                    <button className="tab-close" onClick={() => closeWorkspace(workspace.id)} aria-label={`Close ${workspace.title}`}>×</button>
                  </div>
                ))}
                <div className="tab-row-spacer" />
                <button
                  className="new-editor-btn"
                  title="Open a new SQL editor tab"
                  onClick={() => openSqlEditorWorkspace()}
                >
                  <span className="new-editor-btn-icon" aria-hidden="true">＋</span>
                  New SQL Editor
                </button>
              </div>
              {activeWorkspace && (
                <>
                  {activeWorkspace.type === 'table-data' && renderDataWorkspace(activeWorkspace)}
                  {activeWorkspace.type === 'table-structure' && renderStructureWorkspace(activeWorkspace)}
                  {activeWorkspace.type === 'sql-editor' && renderSqlWorkspace(activeWorkspace)}
                </>
              )}
            </>
          )}
        </main>
      </div>

      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }} onClick={(event) => event.stopPropagation()}>
          <button className="context-menu-item" onClick={() => { void openTableDataWorkspace(selectedSchema, contextMenu.table); }}>Recent 50 Rows</button>
          <button className="context-menu-item" onClick={() => { void openTableStructureWorkspace(selectedSchema, contextMenu.table); }}>View Structure</button>
          <button className="context-menu-item" onClick={() => openSqlEditorWorkspace(`SELECT * FROM ${quoteIdentifier(selectedSchema)}.${quoteIdentifier(contextMenu.table.name)} LIMIT 50;`, selectedSchema, contextMenu.table.name)}>Open SQL Editor</button>
          {contextMenu.table.type === 'table' && (
            <>
              <div className="context-menu-separator" />
              <button className="context-menu-item" onClick={() => { setContextMenu(null); openTableConfigDialog(); }}>Select Visible Tables…</button>
            </>
          )}
          <div className="context-menu-separator" />
          <button className="context-menu-item danger" onClick={() => setDropTableTarget({ schema: selectedSchema, table: contextMenu.table.name })}>Drop Table</button>
        </div>
      )}

      {dropTableTarget && (
        <div className="dialog-backdrop" onClick={() => setDropTableTarget(null)}>
          <div className="dialog-card confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="dialog-header">
              <h3>Drop table?</h3>
            </div>
            <p>Are you sure you want to drop:</p>
            <p className="drop-table-name">{dropTableTarget.schema}.{dropTableTarget.table}</p>
            <p className="drop-table-note">This action cannot be undone.</p>
            <div className="dialog-actions">
              <button className="toolbar-button" onClick={() => setDropTableTarget(null)}>Cancel</button>
              <button className="primary-button danger-button" onClick={() => void handleDropTable()}>Drop Table</button>
            </div>
          </div>
        </div>
      )}

      {pendingDeleteConnection && (
        <div className="dialog-backdrop" onClick={() => setPendingDeleteConnection(null)}>
          <div className="dialog-card confirm-dialog" onClick={(event) => event.stopPropagation()}>
            <div className="dialog-header">
              <h3>Delete saved connection?</h3>
            </div>
            <p>Are you sure you want to remove &quot;{pendingDeleteConnection.name}&quot; from QueryBird?</p>
            <div className="dialog-actions">
              <button className="toolbar-button" onClick={() => setPendingDeleteConnection(null)}>Cancel</button>
              <button className="primary-button danger-button" onClick={confirmDeleteSavedConnection}>Delete</button>
            </div>
          </div>
        </div>
      )}

      {isAboutDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setIsAboutDialogOpen(false)}>
          <div className="dialog-card about-dialog" onClick={(event) => event.stopPropagation()}>
            <img className="about-logo" src="/querybird-logo-with-name.png" alt="QueryBird" />
            <div className="about-version">Version 1.0.0</div>
            <p className="about-copy">A lightweight PostgreSQL client.</p>
            <p className="about-copy">© 2026 Sravan JS</p>
            <div className="dialog-actions compact-actions">
              <button className="primary-button" onClick={() => setIsAboutDialogOpen(false)}>Close</button>
            </div>
          </div>
        </div>
      )}

      {isSettingsDialogOpen && (
        <div className="dialog-backdrop" onClick={() => setIsSettingsDialogOpen(false)}>
          <div
            className="dialog-card settings-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <div>
                <h3 id="settings-dialog-title">Settings &amp; Preferences</h3>
              </div>
              <button
                className="toolbar-button"
                type="button"
                aria-label="Close"
                onClick={() => setIsSettingsDialogOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="settings-body">
              {/* Theme Settings */}
              <div className="settings-section">
                <div className="settings-section-title">Theme / Appearance</div>
                <div className="settings-theme-grid">
                  <button
                    type="button"
                    className={`settings-theme-card ${settings.theme === 'system' ? 'active' : ''}`}
                    onClick={() => updateSettings({ ...settings, theme: 'system' })}
                  >
                    <img className="settings-theme-icon" src="/system_theme_icon.png" alt="System theme" />
                    <span className="settings-theme-label">System Default</span>
                    <span className="settings-hint">({systemPrefersDark ? 'Dark' : 'Light'})</span>
                  </button>
                  <button
                    type="button"
                    className={`settings-theme-card ${settings.theme === 'light' ? 'active' : ''}`}
                    onClick={() => updateSettings({ ...settings, theme: 'light' })}
                  >
                    <img className="settings-theme-icon" src="/light_theme_icon.png" alt="Light theme" />
                    <span className="settings-theme-label">Light</span>
                  </button>
                  <button
                    type="button"
                    className={`settings-theme-card ${settings.theme === 'dark' ? 'active' : ''}`}
                    onClick={() => updateSettings({ ...settings, theme: 'dark' })}
                  >
                    <img className="settings-theme-icon" src="/dark_theme_icon.png" alt="Dark theme" />
                    <span className="settings-theme-label">Dark</span>
                  </button>
                </div>
              </div>

              {/* Typography / Font Settings */}
              <div className="settings-section">
                <div className="settings-section-title">Typography &amp; Fonts</div>
                <div className="settings-font-list">
                  {/* 1. Application UI Font */}
                  <div className="settings-font-card">
                    <div className="settings-font-header">
                      <span className="settings-font-title">1. Application Font</span>
                      <span className="settings-font-scope">UI, Menus, Sidebar, Dialogs, Buttons, Tabs (except SQL Editor &amp; Table View)</span>
                    </div>
                    <div className="settings-font-controls">
                      <select
                        className="settings-font-select"
                        value={APP_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.appFont.toLowerCase()) ? settings.appFont : 'custom'}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === 'custom') {
                            updateSettings({ ...settings, appFont: customAppFontInput || 'Custom' });
                          } else {
                            updateSettings({ ...settings, appFont: val });
                          }
                        }}
                      >
                        {APP_FONT_PRESETS.map((preset) => (
                          <option key={preset.value} value={preset.value}>{preset.label}</option>
                        ))}
                      </select>
                      {(!APP_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.appFont.toLowerCase())) && (
                        <input
                          className="settings-font-input"
                          type="text"
                          placeholder="Font family name (e.g. Comic Sans MS)"
                          value={customAppFontInput}
                          onChange={(e) => {
                            setCustomAppFontInput(e.target.value);
                            updateSettings({ ...settings, appFont: e.target.value });
                          }}
                        />
                      )}
                    </div>
                    <div
                      className="settings-font-preview"
                      style={{ fontFamily: resolveFontFamily(settings.appFont, 'app') }}
                    >
                      Sample UI Text: QueryBird PostgreSQL Client — 0123456789 (The quick brown fox jumps)
                    </div>
                  </div>

                  {/* 2. SQL Editor Font */}
                  <div className="settings-font-card">
                    <div className="settings-font-header">
                      <span className="settings-font-title">2. SQL Editor Font</span>
                      <span className="settings-font-scope">CodeMirror SQL Editor &amp; Query Input</span>
                    </div>
                    <div className="settings-font-controls">
                      <select
                        className="settings-font-select"
                        value={EDITOR_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.editorFont.toLowerCase()) ? settings.editorFont : 'custom'}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === 'custom') {
                            updateSettings({ ...settings, editorFont: customEditorFontInput || 'Custom' });
                          } else {
                            updateSettings({ ...settings, editorFont: val });
                          }
                        }}
                      >
                        {EDITOR_FONT_PRESETS.map((preset) => (
                          <option key={preset.value} value={preset.value}>{preset.label}</option>
                        ))}
                      </select>
                      {(!EDITOR_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.editorFont.toLowerCase())) && (
                        <input
                          className="settings-font-input"
                          type="text"
                          placeholder="Monospace font family name"
                          value={customEditorFontInput}
                          onChange={(e) => {
                            setCustomEditorFontInput(e.target.value);
                            updateSettings({ ...settings, editorFont: e.target.value });
                          }}
                        />
                      )}
                    </div>
                    <div
                      className="settings-font-preview"
                      style={{ fontFamily: resolveFontFamily(settings.editorFont, 'editor') }}
                    >
                      SELECT id, name, created_at FROM users WHERE status = &apos;active&apos; ORDER BY id DESC;
                    </div>
                  </div>

                  {/* 3. Table View Font */}
                  <div className="settings-font-card">
                    <div className="settings-font-header">
                      <span className="settings-font-title">3. Table View Font</span>
                      <span className="settings-font-scope">Data Table, Structure Table, Query Result Grids</span>
                    </div>
                    <div className="settings-font-controls">
                      <select
                        className="settings-font-select"
                        value={TABLE_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.tableFont.toLowerCase()) ? settings.tableFont : 'custom'}
                        onChange={(e) => {
                          const val = e.target.value;
                          if (val === 'custom') {
                            updateSettings({ ...settings, tableFont: customTableFontInput || 'Custom' });
                          } else {
                            updateSettings({ ...settings, tableFont: val });
                          }
                        }}
                      >
                        {TABLE_FONT_PRESETS.map((preset) => (
                          <option key={preset.value} value={preset.value}>{preset.label}</option>
                        ))}
                      </select>
                      {(!TABLE_FONT_PRESETS.some((p) => p.value !== 'custom' && p.value.toLowerCase() === settings.tableFont.toLowerCase())) && (
                        <input
                          className="settings-font-input"
                          type="text"
                          placeholder="Table font family name"
                          value={customTableFontInput}
                          onChange={(e) => {
                            setCustomTableFontInput(e.target.value);
                            updateSettings({ ...settings, tableFont: e.target.value });
                          }}
                        />
                      )}
                    </div>
                    <div
                      className="settings-font-preview"
                      style={{ fontFamily: resolveFontFamily(settings.tableFont, 'table') }}
                    >
                      | 1042 | users | public | integer | 2026-03-31 12:00:00 | NULL |
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="settings-dialog-footer">
              <div className="settings-footer-left">
                <button
                  className="toolbar-button"
                  type="button"
                  onClick={() => {
                    updateSettings(defaultSettings);
                    setCustomAppFontInput('');
                    setCustomEditorFontInput('');
                    setCustomTableFontInput('');
                    showFlash('Settings reset to defaults');
                  }}
                >
                  Reset to Defaults
                </button>
                <button
                  className="toolbar-button"
                  type="button"
                  title="Reload application to restart"
                  onClick={() => window.location.reload()}
                >
                  Restart / Reload App
                </button>
              </div>
              <div className="settings-footer-right">
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => setIsSettingsDialogOpen(false)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isTableConfigDialogOpen && connectionState && (
        <div className="dialog-backdrop" onClick={() => setIsTableConfigDialogOpen(false)}>
          <div
            className="dialog-card table-config-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="table-config-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <div>
                <h3 id="table-config-title">Select Visible Tables</h3>
                <p className="dialog-subtitle">
                  Database: <strong>{connectionState.database}</strong> &bull; Schema: <strong>{selectedSchema}</strong>
                </p>
              </div>
              <button
                className="toolbar-button"
                type="button"
                aria-label="Close"
                onClick={() => setIsTableConfigDialogOpen(false)}
              >
                ✕
              </button>
            </div>

            <div className="table-config-search-wrap">
              <input
                className="table-config-search"
                type="text"
                placeholder="⌕ Search tables..."
                value={tableConfigSearch}
                onChange={(event) => setTableConfigSearch(event.target.value)}
                autoFocus
              />
              {tableConfigSearch && (
                <button
                  className="table-config-search-clear"
                  type="button"
                  aria-label="Clear search"
                  onClick={() => setTableConfigSearch('')}
                >
                  ✕
                </button>
              )}
            </div>

            <div className="table-config-toolbar">
              <div className="table-config-quick-btns">
                <button
                  className="mini-button"
                  type="button"
                  onClick={selectAllTables}
                >
                  Select All
                </button>
                <button
                  className="mini-button"
                  type="button"
                  onClick={deselectAllTables}
                >
                  Deselect All
                </button>
              </div>
              <span className="table-config-count">
                {selectedTableNames.length} of {allSchemaTables.length} tables selected
              </span>
            </div>

            <div className="table-config-list" role="group" aria-label="Tables list">
              {allSchemaTables.length === 0 ? (
                <div className="table-config-empty">No tables found in this schema.</div>
              ) : (() => {
                const matchingTables = allSchemaTables.filter((t) =>
                  t.name.toLowerCase().includes(tableConfigSearch.trim().toLowerCase())
                );
                if (matchingTables.length === 0) {
                  return <div className="table-config-empty">No tables match &quot;{tableConfigSearch}&quot;</div>;
                }
                return matchingTables.map((t) => {
                  const isChecked = selectedTableNames.includes(t.name);
                  return (
                    <label
                      key={t.name}
                      className={`table-config-item ${isChecked ? 'selected' : ''}`}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => toggleTableSelection(t.name)}
                      />
                      <span className="object-icon table" aria-hidden="true">▤</span>
                      <span className="table-config-item-name">{t.name}</span>
                    </label>
                  );
                });
              })()}
            </div>

            <div className="dialog-actions table-config-dialog-actions">
              {configuredVisibleTables && (
                <button
                  className="toolbar-button"
                  type="button"
                  onClick={handleResetTableConfig}
                  title="Reset and show all tables in this database and schema"
                >
                  Show All Tables
                </button>
              )}
              <div className="table-config-action-group">
                <button
                  className="toolbar-button"
                  type="button"
                  onClick={() => setIsTableConfigDialogOpen(false)}
                >
                  Cancel
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={handleSaveTableConfig}
                >
                  Save &amp; Apply
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {isConnectionDialogOpen && (
        <div className="dialog-backdrop" onClick={closeConnectionDialog}>
          <div
            className="dialog-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="connection-dialog-title"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="dialog-header">
              <h3 id="connection-dialog-title">{connectionDialogMode === 'edit' ? 'Edit Connection' : 'New Connection'}</h3>
            </div>
            <div className="dialog-grid">
              <label>
                <span>Connection Name</span>
                <input
                  value={connectionDialogConfig.name}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, name: event.target.value })}
                />
              </label>
              <label>
                <span>Host</span>
                <input
                  value={connectionDialogConfig.host}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, host: event.target.value })}
                />
              </label>
              <label>
                <span>Port</span>
                <input
                  type="number"
                  min="1"
                  max="65535"
                  value={connectionDialogConfig.port}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, port: Number(event.target.value) })}
                />
              </label>
              <label>
                <span>Database</span>
                <input
                  value={connectionDialogConfig.database}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, database: event.target.value })}
                />
              </label>
              <label>
                <span>Username</span>
                <input
                  value={connectionDialogConfig.username}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, username: event.target.value })}
                />
              </label>
              <label>
                <span>Password</span>
                <input
                  type="password"
                  autoComplete="current-password"
                  value={connectionDialogConfig.password}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, password: event.target.value })}
                />
              </label>
              <label>
                <span>SSL mode</span>
                <select
                  value={connectionDialogConfig.sslMode}
                  onChange={(event) => setConnectionDialogConfig({ ...connectionDialogConfig, sslMode: event.target.value })}
                >
                  <option value="disable">disable</option>
                  <option value="prefer">prefer</option>
                  <option value="require">require</option>
                </select>
              </label>
            </div>
            <div className="dialog-actions">
              <button className="toolbar-button" disabled={isConnecting} onClick={() => void handleTestConnection(connectionDialogConfig)}>Test Connection</button>
              <button className="toolbar-button" disabled={isConnecting} onClick={closeConnectionDialog}>Cancel</button>
              <button
                className={`primary-button${isConnecting ? ' connecting' : ''}`}
                disabled={isConnecting}
                onClick={() => void handleConnectionDialogSave()}
              >{isConnecting ? 'Connecting…' : 'Connect'}</button>
            </div>
          </div>
        </div>
      )}

      {cellModal && (
        <div className="dialog-backdrop" onClick={() => setCellModal(null)}>
          <div className="dialog-card cell-value-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header">
              <h3 className="cell-value-dialog-title">
                <span className="cell-value-col">{cellModal.column}</span>
                <span className="cell-value-meta"> — {cellModal.table}</span>
              </h3>
              <button className="toolbar-button" onClick={() => setCellModal(null)}>✕</button>
            </div>
            {cellModal.loading ? (
              <div className="cell-value-loading">Loading…</div>
            ) : (() => {
              const val = cellModal.full ?? cellModal.preview;
              let formatted = val;
              let isJson = false;
              try { JSON.parse(val); formatted = JSON.stringify(JSON.parse(val), null, 2); isJson = true; } catch {}
              return (
                <>
                  <pre className={`cell-value-pre${isJson ? ' cell-value-json' : ''}`}>{formatted}</pre>
                  <div className="dialog-actions">
                    <span className="cell-value-bytes">{new TextEncoder().encode(val).length.toLocaleString()} bytes</span>
                    <button className="toolbar-button" onClick={() => void navigator.clipboard.writeText(val)}>Copy</button>
                    <button className="primary-button" onClick={() => setCellModal(null)}>Close</button>
                  </div>
                </>
              );
            })()}
          </div>
        </div>
      )}

      <footer className="status-bar" aria-label="Application status">
        <span className={`status-bar-indicator ${connectionState ? 'connected' : ''}`} />
        <span title={connectionState ? `${connectionState.host}:${connectionState.port}` : 'No active connection'}>
          {connectionState ? `${connectionState.host}:${connectionState.port}` : 'Disconnected'}
        </span>
        <span className="status-bar-separator" />
        <span>{connectionState ? 'PostgreSQL' : 'No server'}</span>
        <span className="status-bar-separator" />
        <span>{connectionState?.database ?? '—'}</span>
        <span className="status-bar-separator" />
        <span>{connectionState ? selectedSchema : '—'}</span>
        {flashMessage && (
          <span key={flashKey} className="status-bar-flash">{flashMessage}</span>
        )}
      </footer>
    </div>
  );
}

export default App;
