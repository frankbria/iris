# IRIS - Interface Recognition & Interaction Suite

> 👁️ Give your AI eyes to see and test your UI

**⚠️ UNDER ACTIVE DEVELOPMENT - Coming soon!**

IRIS bridges the gap between AI code generation and visual verification, providing a comprehensive suite of tools for UI understanding, testing, and validation.

## What's Coming

- 🤖 AI-powered UI understanding using vision models
- 🎯 Natural language UI commands
- 🔍 Autonomous UI exploration and issue detection  
- ♿ Accessibility validation
- 📸 Intelligent visual regression testing
- 🔌 Integration with AI coding assistants

## Phase 1 - Core Features Available

IRIS Phase 1 provides foundational CLI commands for natural language UI automation.

### Installation

```bash
# Clone and build locally
git clone https://github.com/frankbria/iris.git
cd iris
npm install
npm run build
```

### Usage Examples

**Run natural language commands:**
```bash
# Execute UI commands with natural language
npm start run "click #submit-button"
npm start run "fill #email with user@example.com"
npm start run "navigate to https://example.com"
```

**Watch files or URLs:**
```bash
# Watch for file changes
npm start watch src/components
npm start watch

# Watch URL for changes (future feature)
npm start watch https://localhost:3000
```

**Start JSON-RPC server:**
```bash
# Start WebSocket server for external integrations
npm start connect
npm start connect 8080  # Custom port
```

### Persistence

All test runs are automatically stored in SQLite database:
- Default location: `~/.iris/iris.db`
- Override with: `IRIS_DB_PATH=/custom/path/iris.db`
- Records instruction, status, timestamps

### Development

```bash
# Run tests
npm run test

# Build TypeScript
npm run build

# Development mode
npm start run "your command"
```

## AI Agent Instructions

For step-by-step development guidance, see [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md).

Follow development
- GitHub: github.com/frankbria/iris
- Twitter: @FrankBria18044

Building in public. Star the repo to follow along!

---
IRIS is being actively developed. Expected first release: October 2025
