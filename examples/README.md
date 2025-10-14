# IRIS Examples

Practical examples demonstrating IRIS visual regression and accessibility testing capabilities.

## 📚 Available Examples

### [1. Basic Visual Testing](./basic-visual-test)
**Difficulty:** Beginner
**Time:** 5 minutes

Learn the fundamentals of visual regression testing with IRIS.

**What You'll Learn:**
- Screenshot capture and comparison
- Pixel-based difference detection
- SSIM (Structural Similarity Index) analysis
- Baseline management
- Severity classification

**Use Cases:**
- First-time IRIS users
- Single-page visual testing
- Understanding baseline workflows
- Learning diff algorithms

```bash
cd basic-visual-test
./test-visual.sh
```

---

### [2. Multi-Device Visual Testing](./multi-device-visual)
**Difficulty:** Intermediate
**Time:** 10 minutes

Test responsive designs across desktop, tablet, and mobile viewports.

**What You'll Learn:**
- Multi-device screenshot capture
- Responsive design regression detection
- Parallel test execution
- Device-specific baselines
- Breakpoint validation

**Use Cases:**
- Responsive web applications
- Mobile-first designs
- Cross-device consistency
- Layout regression prevention

```bash
cd multi-device-visual
./test-multidevice.sh
```

---

### [3. Accessibility Audit](./accessibility-audit)
**Difficulty:** Intermediate
**Time:** 15 minutes

Comprehensive WCAG 2.1 AA compliance testing with keyboard and screen reader support.

**What You'll Learn:**
- WCAG compliance validation (axe-core)
- Keyboard navigation testing
- Screen reader simulation
- Focus management validation
- Accessibility scoring

**Use Cases:**
- WCAG compliance requirements
- Keyboard accessibility validation
- Screen reader compatibility
- Color contrast checking
- Semantic HTML validation

```bash
cd accessibility-audit
./test-a11y.sh
```

---

### [4. CI/CD Integration](./ci-cd-integration)
**Difficulty:** Advanced
**Time:** 20 minutes

Integrate IRIS into continuous integration pipelines with GitHub Actions.

**What You'll Learn:**
- GitHub Actions workflow configuration
- Automated baseline management
- PR comment integration
- Artifact storage
- Parallel job execution

**Use Cases:**
- Automated visual testing in CI
- Pre-merge validation
- Baseline auto-updates
- Team collaboration
- Production safeguards

```bash
cd ci-cd-integration
# Copy workflow to your .github/workflows/ directory
```

---

## 🚀 Quick Start

### Prerequisites

```bash
# Install IRIS (from project root)
npm install
npm run build

# Or install globally (when published)
npm install -g iris-suite
```

### Running Examples

Each example is self-contained and can be run independently:

```bash
# Navigate to any example directory
cd examples/basic-visual-test

# Run the test script
./test-visual.sh

# Or run IRIS commands directly
npx http-server -p 8080 &
node ../../dist/cli.js visual-diff --pages "http://localhost:8080/sample-page.html"
```

---

## 📖 Learning Path

### For Beginners
1. **Start:** [basic-visual-test](./basic-visual-test) - Understand fundamentals
2. **Next:** [accessibility-audit](./accessibility-audit) - Learn a11y basics
3. **Then:** [multi-device-visual](./multi-device-visual) - Expand to responsive

### For Teams
1. **Start:** [multi-device-visual](./multi-device-visual) - Cover all devices
2. **Next:** [accessibility-audit](./accessibility-audit) - Ensure compliance
3. **Then:** [ci-cd-integration](./ci-cd-integration) - Automate everything

### For CI/CD Engineers
1. **Start:** [ci-cd-integration](./ci-cd-integration) - Setup automation
2. **Next:** [basic-visual-test](./basic-visual-test) - Understand mechanics
3. **Then:** [multi-device-visual](./multi-device-visual) - Scale testing

---

## 🎯 Use Case Matrix

| Example | Visual Testing | A11y Testing | Multi-Device | CI/CD |
|---------|---------------|--------------|--------------|-------|
| Basic Visual Test | ✅ Core | ❌ | ❌ | ❌ |
| Multi-Device | ✅ Advanced | ❌ | ✅ | ❌ |
| A11y Audit | ❌ | ✅ Core | ❌ | ❌ |
| CI/CD Integration | ✅ | ✅ | ✅ | ✅ |

---

## 💡 Example Features

### Visual Regression Testing
- **Baseline Management**: Git-integrated baseline storage
- **Diff Algorithms**: Pixelmatch + SSIM analysis
- **Severity Classification**: Breaking, Moderate, Minor
- **Page Stabilization**: Font loading, animation disable, network idle
- **Multi-Device**: Desktop, tablet, mobile viewports
- **Parallel Execution**: Configurable concurrency

### Accessibility Testing
- **WCAG Compliance**: 2.1 Level A, AA, AAA support
- **axe-core Integration**: Industry-standard a11y engine
- **Keyboard Testing**: Tab order, focus traps, arrow navigation
- **Screen Reader**: ARIA validation, landmark structure
- **Impact Levels**: Critical, Serious, Moderate, Minor
- **Scoring**: 0-100 accessibility score

### CI/CD Integration
- **GitHub Actions**: Complete workflow examples
- **Automated Baselines**: Auto-update on main branch
- **PR Comments**: Test results in pull requests
- **Artifact Storage**: Reports and screenshots
- **Parallel Jobs**: Visual + A11y in parallel
- **Caching**: Dependency and build caching

---

## 🛠️ Configuration

Each example includes an `.irisrc` configuration file:

```json
{
  "visual": {
    "threshold": 0.1,
    "devices": ["desktop", "tablet", "mobile"],
    "baseline": {
      "strategy": "branch",
      "reference": "main"
    }
  },
  "accessibility": {
    "tags": ["wcag2a", "wcag2aa"],
    "failOn": ["critical", "serious"]
  }
}
```

---

## 📊 Expected Outputs

### Visual Testing
```
.iris/
├── baselines/          # Reference screenshots
├── screenshots/
│   ├── current/       # Latest captures
│   └── diff/          # Difference images
└── visual-report.html # HTML report
```

### Accessibility Testing
```
.iris/
├── a11y-report.html   # Accessibility report
└── iris.db            # Test results database
```

---

## 🔧 Troubleshooting

### Server Not Starting
```bash
# Check if port is in use
lsof -i :8080

# Use different port
npx http-server -p 8081
iris visual-diff --pages "http://localhost:8081/page.html"
```

### Baseline Not Found
```bash
# Create initial baseline
iris visual-diff --update-baseline
```

### Font Rendering Differences
```bash
# Install system fonts (Ubuntu/Debian)
sudo apt-get install fonts-liberation

# Enable font wait in .irisrc
"stabilization": { "waitForFonts": true }
```

### Flaky Tests
```bash
# Increase stabilization delay
"stabilization": { "delay": 1000 }

# Disable animations
"stabilization": { "disableAnimations": true }

# Increase threshold
iris visual-diff --threshold 0.15
```

---

## 📚 Additional Resources

### Documentation
- [IRIS README](../README.md) - Project overview
- [Technical Architecture](../docs/phase2_technical_architecture.md) - Detailed design
- [Development Guide](../docs/DEVELOPMENT_INSTRUCTIONS.md) - Contributing

### API Reference
- [Visual Testing API](../src/visual/) - Visual testing modules
- [A11y Testing API](../src/a11y/) - Accessibility modules
- [CLI Reference](../src/cli.ts) - Command-line interface

### Community
- [GitHub Issues](https://github.com/frankbria/iris/issues) - Bug reports
- [Discussions](https://github.com/frankbria/iris/discussions) - Questions
- [Twitter](https://twitter.com/FrankBria18044) - Updates

---

## 🤝 Contributing

Have a great example idea? Contributions welcome!

1. Fork the repository
2. Create example directory: `examples/your-example/`
3. Add README.md with clear instructions
4. Include sample files and test scripts
5. Update this README.md
6. Submit pull request

---

## 📝 License

MIT - see [LICENSE](../LICENSE)

---

## ⭐ Quick Links

- **Installation:** `npm install iris-suite`
- **First Example:** [basic-visual-test](./basic-visual-test)
- **CI Setup:** [ci-cd-integration](./ci-cd-integration)
- **GitHub:** [github.com/frankbria/iris](https://github.com/frankbria/iris)

---

**Built with ❤️ by developers, for developers**

Start testing visually and accessibly today! 🎯♿
