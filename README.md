# QueryBird

A lightweight PostgreSQL desktop client built with Go, Wails, React, and TypeScript.

<img width="1723" height="1045" alt="image" src="https://github.com/user-attachments/assets/b8fdd107-a805-4989-8e2f-b16b89c27af7" />

## Features

- **Connection management** — save, edit, and reconnect to multiple PostgreSQL instances with SSL mode support
- **Database & schema explorer** — browse databases, switch schemas, filter objects instantly
- **Object tree** — tables, views, materialized views, indexes, sequences, functions, types, extensions — grouped and alphabetised
- **Table data browser** — paginated rows, quick column/operator/value filter bar, page size control
- **Quick filter** — filter table data and query results client-side with 12 operators (`=`, `<>`, `LIKE`, `ILIKE`, `IS NULL`, etc.)
- **Table structure viewer** — columns, types, nullable, default, PK, FK, unique, comments
- **SQL editor** — CodeMirror 6 with PostgreSQL syntax highlighting and GitHub Light/Dark theme
- **Run query / Run selection** — execute full query or highlighted text (`⌘↵`)
- **Query cancellation** — cancel a long-running query mid-execution
- **Editable results** — double-click cells in `SELECT * FROM table` results to edit; transactional save/revert
- **Saved queries** — store and recall up to 10 frequently used queries
- **New SQL Editor button** — open a fresh editor tab from the tab bar
- **Resizable result panel** — drag to resize the query results pane
- **Visible table configuration** — choose which tables appear in the sidebar per database/schema
- **Connection-loss detection** — automatic reconnect banner for `kubectl port-forward`, SSH tunnels, etc.
- **Theme support** — Light, Dark, System Default
- **Font customisation** — separate font settings for UI, SQL editor, and table view
- **Status bar** — connection info, active database/schema, row counts, query timing

---

## Download

Pre-built macOS (Apple Silicon) DMG releases are available on the [Releases](https://github.com/sravanjs/querybird/releases) page.

> **Note:** QueryBird is not notarized by Apple. On first launch macOS may show a security warning.
> Right-click the app → **Open** → **Open** to bypass it, or run:
> ```bash
> xattr -cr /path/to/QueryBird.dmg
> ```

---

## Prerequisites

Install the following before building or running QueryBird from source.

### 1. Go

Install Go 1.22 or later from <https://go.dev/dl/> or via Homebrew:

```bash
brew install go
```

Verify:

```bash
go version
```

### 2. Node.js & npm

Install Node.js 20 or later from <https://nodejs.org/> or via Homebrew:

```bash
brew install node
```

Verify:

```bash
node --version
npm --version
```

### 3. Wails CLI

```bash
go install github.com/wailsapp/wails/v2/cmd/wails@latest
```

Make sure the Go binary directory is on your `PATH`:

```bash
export PATH="$PATH:$(go env GOPATH)/bin"
```

Add that export to your `~/.zshrc` or `~/.bash_profile` to make it permanent.

Verify:

```bash
wails version
```

### 4. Xcode Command Line Tools (macOS)

```bash
xcode-select --install
```

---

## Development

Clone the repository and start the dev server:

```bash
git clone https://github.com/sravanjs/querybird.git
cd querybird
export PATH="$PATH:$(go env GOPATH)/bin"
wails dev
```

This compiles the Go backend, starts the Vite dev server for the React frontend, and opens the native macOS window. The frontend supports hot module replacement — changes under `frontend/src/` are reflected instantly without restarting.

The connection form defaults to `localhost:5432`, database `mydb`, user `postgres`. Passwords are **never** saved to disk.

---

## Building

### macOS App Bundle

```bash
export PATH="$PATH:$(go env GOPATH)/bin"

# Copy app icon (querybird-mark.png is the source)
mkdir -p build
cp frontend/public/querybird-mark.png build/appicon.png

wails build
```

The output is `build/bin/QueryBird.app`. Launch it:

```bash
open build/bin/QueryBird.app
```

### Frontend only (no desktop shell)

Useful for catching TypeScript/CSS errors without the full Wails toolchain:

```bash
cd frontend
npm install
npm run build
```

---

## DMG Packaging

Requires `create-dmg` (`brew install create-dmg`).

```bash
create-dmg \
  --volname "QueryBird" \
  --volicon "packaging/dmg/VolumeIcon.icns" \
  --background "packaging/dmg/background@2x.png" \
  --window-pos 200 120 \
  --window-size 660 420 \
  --icon-size 120 \
  --icon "QueryBird.app" 170 280 \
  --hide-extension "QueryBird.app" \
  --app-drop-link 490 280 \
  "build/bin/QueryBird.dmg" \
  "build/bin/QueryBird.app"
```

---

## Testing

### Unit / integration tests (no live database required)

```bash
go test ./...
```

### PostgreSQL integration tests

```bash
DBCLIENT_TEST_PASSWORD=yourpassword go test .
```

Optional environment variable overrides:

| Variable | Default | Description |
|---|---|---|
| `DBCLIENT_TEST_HOST` | `localhost` | PostgreSQL host |
| `DBCLIENT_TEST_PORT` | `5432` | PostgreSQL port |
| `DBCLIENT_TEST_DATABASE` | `mydb` | Target database |
| `DBCLIENT_TEST_USERNAME` | `postgres` | Login role |
| `DBCLIENT_TEST_PASSWORD` | *(required)* | Password |
| `DBCLIENT_TEST_SSLMODE` | `prefer` | SSL mode |

### Port-forward / tunnel tests

`app_portforward_test.go` tests connection-loss detection and reconnect behaviour through `kubectl port-forward` or SSH tunnels. These require a live remote PostgreSQL instance and are skipped automatically unless credentials and a tunnel are configured.

---

## Project Layout

```
querybird/
├── main.go                     # Wails entry point; window options
├── app.go                      # Backend API surface bound to the frontend
├── app_integration_test.go     # PostgreSQL integration tests
├── app_portforward_test.go     # Port-forward resilience tests
├── internal/
│   ├── models/                 # Shared data structures
│   └── postgres/
│       ├── connection/         # Connect / disconnect / error classification
│       ├── metadata/           # Database, schema, object, column queries
│       └── query/              # SQL execution and editable result sets
├── frontend/
│   ├── src/
│   │   ├── App.tsx             # Main application component
│   │   └── App.css             # All styles and design tokens
│   ├── public/                 # Static assets (icons, logos)
│   ├── wailsjs/                # Auto-generated Go ↔ JS bindings
│   └── package.json
├── packaging/
│   └── dmg/                    # macOS DMG assets
├── build/
│   └── appicon.png             # App icon source (not committed)
└── wails.json                  # Wails project configuration
```

---

## Technology Stack

| Layer | Technology |
|---|---|
| Desktop shell | [Wails v2](https://wails.io) |
| Backend language | Go 1.22+ |
| PostgreSQL driver | [pgx v5](https://github.com/jackc/pgx) |
| Frontend framework | React 19 + TypeScript |
| Bundler | Vite 7 |
| SQL editor | CodeMirror 6 |
| Styling | Plain CSS with design tokens |

---

## Contributing

Contributions are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

---

## License

MIT © 2026 Sravan JS — see [LICENSE](LICENSE) for details.
