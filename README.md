# IRIS - Interface Recognition & Interaction Suite

> 👁️ Give your AI eyes to see and test your UI

**✅ Phase 1 Complete - Ready for Testing!**

IRIS bridges the gap between AI code generation and visual verification, providing a comprehensive suite of tools for UI understanding, testing, and validation.

## Features Available Now

- ✅ **Natural language UI commands** - Translate plain English into browser actions
- ✅ **AI-powered translation** - OpenAI/Anthropic/Ollama integration for complex commands
- ✅ **File watching** - Automatic re-execution on code changes with debouncing
- ✅ **Configuration system** - BYOK (Bring Your Own Key) for AI providers
- ✅ **SQLite persistence** - Automatic storage of test runs and results
- ✅ **JSON-RPC protocol** - Integration with AI coding assistants

## Coming in Phase 2

- 🔍 Autonomous UI exploration and issue detection
- ♿ Accessibility validation
- 📸 Intelligent visual regression testing
- 🎨 Design system compliance checking

## Phase 1 - Core Features

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

# Complex commands powered by AI (requires API key)
export OPENAI_API_KEY=sk-your-key
npm start run "find the blue button next to the search box and click it"
```

**Watch files and auto-execute commands:**
```bash
# Watch for file changes and run command when files change
npm start watch src/components --instruction "click submit"
npm start watch "*.ts" --instruction "navigate to http://localhost:3000"

# Watch current directory with default instruction
npm start watch
```

**Start JSON-RPC server:**
```bash
# Start WebSocket server for external integrations
npm start connect
npm start connect 8080  # Custom port
```

### Configuration

**AI Provider Setup:**
```bash
# OpenAI (recommended)
export OPENAI_API_KEY=sk-your-key

# Anthropic Claude
export ANTHROPIC_API_KEY=ant-your-key

# Local Ollama
export OLLAMA_ENDPOINT=http://localhost:11434
export OLLAMA_MODEL=llama2
```

**Config File (optional):**
Create `~/.iris/config.json` for persistent settings:
```json
{
  "ai": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "apiKey": "sk-your-key"
  },
  "watch": {
    "patterns": ["**/*.{ts,tsx,js,jsx}"],
    "debounceMs": 1000
  }
}
```

### Persistence

All test runs are automatically stored in SQLite database:
- Default location: `~/.iris/iris.db`
- Override with: `IRIS_DB_PATH=/custom/path/iris.db`
- Records instruction, status, timestamps, and translation method

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

## Phase 1 Completion Summary

🎉 **IRIS Phase 1 is now complete!** All foundation components have been implemented:

- **CLI Framework**: Full commander.js implementation with all three commands
- **Natural Language Translation**: Enhanced pattern matching + AI fallback
- **File Watching**: Complete chokidar integration with debouncing and glob patterns
- **AI Integration**: OpenAI/Anthropic/Ollama support with BYOK configuration
- **Data Persistence**: SQLite database with comprehensive test run tracking
- **Protocol Layer**: JSON-RPC 2.0 over WebSocket for tool integrations
- **Test Coverage**: 93%+ coverage across all modules

Ready for Phase 2 development! Expected Phase 2 release: January 2026
