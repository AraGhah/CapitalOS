// Imported first by the MCP server: its stdout is the protocol, so every log
// line goes to stderr. Set before any module creates the logger.
process.env.CAPITALOS_LOG_STDERR = "1";
process.env.CAPITALOS_SERVICE ??= "capitalos-mcp";

export {};
