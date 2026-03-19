# mymcp

A personal MCP (Model Context Protocol) server with tools for day-to-day development work. Currently includes SQL Server exploration and file utilities, with more tools added over time.

## Tools

| Tool | Description |
|---|---|
| `execute_sql` | Run a SQL query against the configured SQL Server. Always rolls back — safe for exploration. |
| `get_table_schema` | Get columns, types, primary keys, foreign keys, and indexes for a table. |
| `search_schema` | Search all tables and columns by keyword across the entire database. |
| `diff_files` | Compare two local files and return a unified diff. |

---

## Requirements

- Node.js 18 or later
- npm

---

## Installation

### 1. Clone and install dependencies

```bash
git clone <your-repo-url> mymcp
cd mymcp
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env
```

`.env` fields:

| Variable | Description | Default |
|---|---|---|
| `MSSQL_SERVER` | SQL Server hostname or IP | — |
| `MSSQL_DATABASE` | Database name | — |
| `MSSQL_USER` | Login username | — |
| `MSSQL_PASSWORD` | Login password | — |
| `MSSQL_PORT` | Port | `1433` |
| `MSSQL_ENCRYPT` | Use encrypted connection | `true` |
| `MSSQL_TRUST_CERT` | Trust self-signed certificates | `false` |

Set `MSSQL_TRUST_CERT=true` for local development with self-signed certs. Set `MSSQL_ENCRYPT=false` only if your server does not support encryption.

---

## Registering with Claude Code

Add the server to your Claude Code MCP config. Run this from inside the `mymcp` directory:

```bash
claude mcp add mymcp node /absolute/path/to/mymcp/index.js
```

Or edit `~/.claude/settings.json` (global) or `.claude/settings.json` (project-level) manually:

```json
{
  "mcpServers": {
    "mymcp": {
      "command": "node",
      "args": ["/absolute/path/to/mymcp/index.js"]
    }
  }
}
```

Restart Claude Code after making changes. Verify the server is connected with:

```bash
claude mcp list
```

---

## Registering with VS Code (GitHub Copilot / Continue / MCP-compatible extension)

### Continue extension

Open your Continue config file (`~/.continue/config.json`) and add under `"mcpServers"`:

```json
{
  "mcpServers": [
    {
      "name": "mymcp",
      "command": "node",
      "args": ["/absolute/path/to/mymcp/index.js"]
    }
  ]
}
```

### VS Code settings (for extensions that read `settings.json`)

Open your user `settings.json` (`Ctrl+Shift+P` > "Open User Settings (JSON)") and add:

```json
{
  "mcp.servers": {
    "mymcp": {
      "command": "node",
      "args": ["/absolute/path/to/mymcp/index.js"]
    }
  }
}
```

---

## Registering globally (Claude Desktop / any MCP host)

Edit the Claude Desktop config file:

- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "mymcp": {
      "command": "node",
      "args": ["C:/absolute/path/to/mymcp/index.js"]
    }
  }
}
```

Restart Claude Desktop after saving.

---

## Notes

- All paths in config files must be absolute.
- On Windows, use forward slashes or escaped backslashes in JSON paths.
- Environment variables are loaded from the `.env` file next to `index.js` via `dotenv`. If you move or symlink the file, make sure the `.env` is in the same directory.
- `execute_sql` always wraps queries in a transaction that is rolled back. It cannot modify data. This is intentional.
