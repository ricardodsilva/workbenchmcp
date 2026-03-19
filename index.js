#!/usr/bin/env node
import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import sql from 'mssql';
import { readFile, writeFile, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createTwoFilesPatch } from 'diff';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MEMORY_FILE = join(__dirname, 'memory.txt');

const sqlConfig = {
  server: process.env.MSSQL_SERVER,
  database: process.env.MSSQL_DATABASE,
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  port: parseInt(process.env.MSSQL_PORT || '1433'),
  options: {
    encrypt: process.env.MSSQL_ENCRYPT !== 'false',
    trustServerCertificate: process.env.MSSQL_TRUST_CERT === 'true',
  },
};

const server = new Server(
  { name: 'mymcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'execute_sql',
      description:
        'Execute a SQL query against the configured SQL Server database. ' +
        'Every query is wrapped in BEGIN TRAN / ROLLBACK TRAN — changes are NEVER committed. ' +
        'Safe for exploration, reading data, and testing queries.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The SQL query to execute.',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'get_table_schema',
      description:
        'Returns the full schema of a SQL Server table: columns (name, type, nullability, default), ' +
        'primary keys, foreign keys, and indexes.',
      inputSchema: {
        type: 'object',
        properties: {
          table: {
            type: 'string',
            description: 'Table name. Can be schema-qualified, e.g. "dbo.Orders" or just "Orders".',
          },
        },
        required: ['table'],
      },
    },
    {
      name: 'search_schema',
      description:
        'Search all tables and columns in the database whose name contains the given keyword (case-insensitive). ' +
        'Returns matching table names and column names with their table.',
      inputSchema: {
        type: 'object',
        properties: {
          keyword: {
            type: 'string',
            description: 'Substring to search for in table and column names.',
          },
        },
        required: ['keyword'],
      },
    },
    {
      name: 'diff_files',
      description:
        'Compare two local files and return a unified diff showing what changed between them.',
      inputSchema: {
        type: 'object',
        properties: {
          file_a: {
            type: 'string',
            description: 'Absolute path to the first (original) file.',
          },
          file_b: {
            type: 'string',
            description: 'Absolute path to the second (modified) file.',
          },
        },
        required: ['file_a', 'file_b'],
      },
    },
    {
      name: 'search_translation',
      description:
        'Search the t_messages table for a translation by similar text (used in M("defaultText","key") or T.M("defaultText","key") calls). ' +
        'Searches all text columns with a LIKE match and returns all columns for matching rows. ' +
        'If no match is found, returns "x,x,x" to indicate the key is unknown.',
      inputSchema: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'The default text or partial text to search for in t_messages.',
          },
        },
        required: ['text'],
      },
    },
    {
      name: 'memory',
      description:
        'A shared persistent memory file (memory.txt) that survives across sessions and is accessible from any LLM (Claude, Copilot, etc.). ' +
        'Use this to store and retrieve context, decisions, notes, or anything useful to remember between conversations.',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'append'],
            description: '"read" returns the full memory contents. "write" overwrites the entire file. "append" adds text to the end.',
          },
          text: {
            type: 'string',
            description: 'The text to write or append. Not required for "read".',
          },
        },
        required: ['action'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // ── diff_files ──────────────────────────────────────────────────────────────
  if (name === 'diff_files') {
    const { file_a, file_b } = args;
    try {
      const [contentA, contentB] = await Promise.all([
        readFile(file_a, 'utf8'),
        readFile(file_b, 'utf8'),
      ]);
      const patch = createTwoFilesPatch(file_a, file_b, contentA, contentB);
      const text = patch.trim() === `--- ${file_a}\n+++ ${file_b}` ? 'Files are identical.' : patch;
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // ── memory ───────────────────────────────────────────────────────────────────
  if (name === 'memory') {
    const { action, text: memText } = args;
    try {
      if (action === 'read') {
        let content;
        try {
          content = await readFile(MEMORY_FILE, 'utf8');
          if (!content.trim()) content = '(memory is empty)';
        } catch {
          content = '(memory is empty)';
        }
        return { content: [{ type: 'text', text: content }] };
      }
      if (action === 'write') {
        await writeFile(MEMORY_FILE, memText ?? '', 'utf8');
        return { content: [{ type: 'text', text: 'Memory written.' }] };
      }
      if (action === 'append') {
        await appendFile(MEMORY_FILE, '\n' + (memText ?? ''), 'utf8');
        return { content: [{ type: 'text', text: 'Memory updated.' }] };
      }
      return { content: [{ type: 'text', text: `Unknown action: ${action}` }], isError: true };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }

  // ── SQL tools ────────────────────────────────────────────────────────────────
  if (!['execute_sql', 'get_table_schema', 'search_schema', 'search_translation'].includes(name)) {
    throw new Error(`Unknown tool: ${name}`);
  }

  if (!sqlConfig.server || !sqlConfig.database) {
    return {
      content: [{ type: 'text', text: 'SQL Server not configured. Set MSSQL_SERVER and MSSQL_DATABASE environment variables (see .env.example).' }],
      isError: true,
    };
  }

  // ── get_table_schema ─────────────────────────────────────────────────────────
  if (name === 'get_table_schema') {
    const { table } = args;
    const [schema, tbl] = table.includes('.') ? table.split('.') : ['%', table];
    const pool = await sql.connect(sqlConfig);
    try {
      const r = pool.request();
      r.input('schema', sql.NVarChar, schema);
      r.input('table', sql.NVarChar, tbl);

      const [cols, pks, fks, idxs] = await Promise.all([
        r.query(`
          SELECT c.COLUMN_NAME, c.DATA_TYPE,
                 c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE,
                 c.IS_NULLABLE, c.COLUMN_DEFAULT
          FROM INFORMATION_SCHEMA.COLUMNS c
          WHERE c.TABLE_SCHEMA LIKE @schema AND c.TABLE_NAME = @table
          ORDER BY c.ORDINAL_POSITION`),
        r.query(`
          SELECT kcu.COLUMN_NAME
          FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
            ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
          WHERE tc.CONSTRAINT_TYPE = 'PRIMARY KEY'
            AND tc.TABLE_SCHEMA LIKE @schema AND tc.TABLE_NAME = @table
          ORDER BY kcu.ORDINAL_POSITION`),
        r.query(`
          SELECT kcu.COLUMN_NAME,
                 ccu.TABLE_SCHEMA AS REF_SCHEMA, ccu.TABLE_NAME AS REF_TABLE, ccu.COLUMN_NAME AS REF_COLUMN,
                 rc.UPDATE_RULE, rc.DELETE_RULE
          FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
          JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
            ON rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME AND rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
          JOIN INFORMATION_SCHEMA.CONSTRAINT_COLUMN_USAGE ccu
            ON rc.UNIQUE_CONSTRAINT_NAME = ccu.CONSTRAINT_NAME
          JOIN INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
            ON rc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
          WHERE tc.TABLE_SCHEMA LIKE @schema AND tc.TABLE_NAME = @table`),
        r.query(`
          SELECT i.name AS INDEX_NAME, i.type_desc AS INDEX_TYPE, i.is_unique AS IS_UNIQUE,
                 STRING_AGG(c.name, ', ') WITHIN GROUP (ORDER BY ic.key_ordinal) AS COLUMNS
          FROM sys.indexes i
          JOIN sys.index_columns ic ON i.object_id = ic.object_id AND i.index_id = ic.index_id
          JOIN sys.columns c ON ic.object_id = c.object_id AND ic.column_id = c.column_id
          JOIN sys.tables t ON i.object_id = t.object_id
          JOIN sys.schemas s ON t.schema_id = s.schema_id
          WHERE s.name LIKE @schema AND t.name = @table AND i.is_primary_key = 0
          GROUP BY i.name, i.type_desc, i.is_unique`),
      ]);

      const pkCols = new Set(pks.recordset.map(r => r.COLUMN_NAME));

      const colLines = cols.recordset.map(c => {
        let type = c.DATA_TYPE;
        if (c.CHARACTER_MAXIMUM_LENGTH) type += `(${c.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : c.CHARACTER_MAXIMUM_LENGTH})`;
        else if (c.NUMERIC_PRECISION != null) type += `(${c.NUMERIC_PRECISION}${c.NUMERIC_SCALE != null ? ',' + c.NUMERIC_SCALE : ''})`;
        const flags = [
          pkCols.has(c.COLUMN_NAME) ? 'PK' : null,
          c.IS_NULLABLE === 'NO' ? 'NOT NULL' : 'NULL',
          c.COLUMN_DEFAULT ? `DEFAULT ${c.COLUMN_DEFAULT}` : null,
        ].filter(Boolean).join('  ');
        return `  ${c.COLUMN_NAME.padEnd(30)} ${type.padEnd(20)} ${flags}`;
      });

      const fkLines = fks.recordset.map(f =>
        `  ${f.COLUMN_NAME} → ${f.REF_SCHEMA}.${f.REF_TABLE}(${f.REF_COLUMN})  [ON UPDATE ${f.UPDATE_RULE}, ON DELETE ${f.DELETE_RULE}]`
      );

      const idxLines = idxs.recordset.map(i =>
        `  ${i.INDEX_NAME}  ${i.INDEX_TYPE}${i.IS_UNIQUE ? '  UNIQUE' : ''}  (${i.COLUMNS})`
      );

      let out = `=== ${table} ===\n\nCOLUMNS\n${colLines.join('\n')}`;
      if (fkLines.length) out += `\n\nFOREIGN KEYS\n${fkLines.join('\n')}`;
      if (idxLines.length) out += `\n\nINDEXES\n${idxLines.join('\n')}`;

      return { content: [{ type: 'text', text: out }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    } finally {
      await pool.close();
    }
  }

  // ── search_translation ───────────────────────────────────────────────────────
  if (name === 'search_translation') {
    const { text } = args;
    const pool = await sql.connect(sqlConfig);
    try {
      const colsResult = await pool.request().query(`
        SELECT COLUMN_NAME
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_NAME = 't_messages'
          AND DATA_TYPE IN ('varchar','nvarchar','char','nchar','text','ntext')
      `);

      if (colsResult.recordset.length === 0) {
        return { content: [{ type: 'text', text: 'Table t_messages not found or has no text columns.' }], isError: true };
      }

      const textCols = colsResult.recordset.map(r => r.COLUMN_NAME);
      const whereClause = textCols.map(col => `[${col}] LIKE @search`).join(' OR ');

      const r = pool.request();
      r.input('search', sql.NVarChar, `%${text}%`);
      const result = await r.query(`SELECT TOP 10 * FROM t_messages WHERE ${whereClause}`);

      if (result.recordset.length === 0) {
        return { content: [{ type: 'text', text: 'x,x,x' }] };
      }

      return { content: [{ type: 'text', text: JSON.stringify(result.recordset, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    } finally {
      await pool.close();
    }
  }

  // ── search_schema ────────────────────────────────────────────────────────────
  if (name === 'search_schema') {
    const { keyword } = args;
    const pool = await sql.connect(sqlConfig);
    try {
      const r = pool.request();
      r.input('kw', sql.NVarChar, `%${keyword}%`);

      const [tables, columns] = await Promise.all([
        r.query(`
          SELECT TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE
          FROM INFORMATION_SCHEMA.TABLES
          WHERE TABLE_NAME LIKE @kw
          ORDER BY TABLE_SCHEMA, TABLE_NAME`),
        r.query(`
          SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME, DATA_TYPE,
                 CHARACTER_MAXIMUM_LENGTH, NUMERIC_PRECISION, NUMERIC_SCALE
          FROM INFORMATION_SCHEMA.COLUMNS
          WHERE COLUMN_NAME LIKE @kw
          ORDER BY TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME`),
      ]);

      let out = `Search results for "${keyword}"\n`;

      if (tables.recordset.length) {
        out += `\nMATCHING TABLES (${tables.recordset.length})\n`;
        out += tables.recordset.map(t => `  ${t.TABLE_SCHEMA}.${t.TABLE_NAME}  [${t.TABLE_TYPE}]`).join('\n');
      } else {
        out += '\nNo matching tables.';
      }

      if (columns.recordset.length) {
        out += `\n\nMATCHING COLUMNS (${columns.recordset.length})\n`;
        out += columns.recordset.map(c => {
          let type = c.DATA_TYPE;
          if (c.CHARACTER_MAXIMUM_LENGTH) type += `(${c.CHARACTER_MAXIMUM_LENGTH === -1 ? 'MAX' : c.CHARACTER_MAXIMUM_LENGTH})`;
          else if (c.NUMERIC_PRECISION != null) type += `(${c.NUMERIC_PRECISION}${c.NUMERIC_SCALE != null ? ',' + c.NUMERIC_SCALE : ''})`;
          return `  ${c.TABLE_SCHEMA}.${c.TABLE_NAME}.${c.COLUMN_NAME}  ${type}`;
        }).join('\n');
      } else {
        out += '\n\nNo matching columns.';
      }

      return { content: [{ type: 'text', text: out }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    } finally {
      await pool.close();
    }
  }

  // ── execute_sql ──────────────────────────────────────────────────────────────
  const { query } = args;
  let pool;
  let transaction;

  try {
    pool = await sql.connect(sqlConfig);
    transaction = new sql.Transaction(pool);
    await transaction.begin();

    const request_ = new sql.Request(transaction);
    const result = await request_.query(query);

    // Always rollback — we never commit
    await transaction.rollback();

    const recordsets = result.recordsets ?? (result.recordset ? [result.recordset] : []);
    const rowsAffected = result.rowsAffected ?? [];

    let output = '';

    if (recordsets.length > 0) {
      recordsets.forEach((recordset, i) => {
        if (recordsets.length > 1) output += `\n--- Result set ${i + 1} ---\n`;
        output += JSON.stringify(recordset, null, 2);
      });
    } else {
      output = `Rows affected: ${rowsAffected.join(', ')}`;
    }

    output += '\n\n⚠️  Transaction was rolled back. No changes were persisted.';

    return { content: [{ type: 'text', text: output }] };
  } catch (err) {
    if (transaction) {
      try { await transaction.rollback(); } catch (_) {}
    }
    return {
      content: [{ type: 'text', text: `Error: ${err.message}` }],
      isError: true,
    };
  } finally {
    if (pool) await pool.close();
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
