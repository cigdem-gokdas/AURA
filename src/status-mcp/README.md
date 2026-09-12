# AURA status MCP

`npm run status:mcp` starts a separate stdio MCP server with four read-only tools. It reads the atomic, owner-only `.aura/status.json` projection of AURA's existing JudgeSnapshot. The trading process publishes this file after observer snapshots; the status process never connects to OKX, ATK, or an LLM. If AURA is not running or has not published a snapshot, tools report unavailable state.

Generic MCP host registration (set the working directory to this repository):

```json
{
  "mcpServers": {
    "aura-status": {
      "command": "npm",
      "args": ["run", "--silent", "status:mcp"],
      "cwd": "/absolute/path/to/AURA"
    }
  }
}
```

The audit history is append-only JSONL at `.aura/audit.jsonl`. `AURA_STATUS_SNAPSHOT_PATH` and `AURA_AUDIT_PATH` may override the local paths. Keep both files on the same trusted machine and protect directory access.
