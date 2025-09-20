# Phase 2 Architecture: Visual Regression Testing

**Version:** 2.0
**Date:** 2025-09-19
**Status:** Design Complete - Ready for Implementation

---

## Executive Summary

Phase 2 extends IRIS with intelligent visual regression testing capabilities that go beyond simple pixel comparison. The architecture combines traditional screenshot diffing with AI-powered semantic analysis to distinguish between intentional design changes and actual regressions, providing developers with actionable insights rather than noise.

### Key Differentiators

- **AI-Enhanced Analysis**: Semantic understanding of visual changes vs. pixel-level differences
- **Context-Aware Severity**: Intelligent classification based on UI region importance
- **Git Integration**: Automatic baseline management tied to branch workflow
- **Progressive Enhancement**: Builds on Phase 1 foundation without breaking changes

---

## System Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Phase 2 Visual Architecture              │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │   Capture   │    │   Storage   │    │  Analysis   │     │
│  │   Engine    │───▶│   Manager   │───▶│   Engine    │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│         │                   │                   │          │
│         ▼                   ▼                   ▼          │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐     │
│  │ Screenshot  │    │  Baseline   │    │ Diff + AI   │     │
│  │ Processor   │    │  Database   │    │ Classifier  │     │
│  └─────────────┘    └─────────────┘    └─────────────┘     │
│         │                   │                   │          │
│         └───────────────────┼───────────────────┘          │
│                             ▼                              │
│                    ┌─────────────┐                         │
│                    │   Report    │                         │
│                    │  Generator  │                         │
│                    └─────────────┘                         │
└─────────────────────────────────────────────────────────────┘

Integration Points:
├── Phase 1 CLI (iris visual-diff command)
├── Phase 1 Browser (screenshot capabilities)
├── Phase 1 Config (visual.* settings)
├── Phase 1 Database (visual_diffs table)
└── Phase 1 AI Client (semantic analysis)
```

---

## Core Components

### 1. Visual Capture Engine (`src/visual/capture.ts`)

**Responsibility**: Orchestrate screenshot capture with standardization and optimization.

```typescript
interface CaptureConfig {
  target: 'viewport' | 'fullPage' | string; // selector
  options: {
    animations: 'disabled' | 'allow';
    waitForFonts: boolean;
    device?: DeviceDescriptor;
    excludeSelectors?: string[];
    maskSelectors?: string[];
  };
}

interface CaptureResult {
  screenshot: Buffer;
  metadata: {
    timestamp: Date;
    url: string;
    viewport: { width: number; height: number };
    device?: string;
    hash: string; // SHA-256 of image data
  };
}

class VisualCaptureEngine {
  async capture(page: Page, config: CaptureConfig): Promise<CaptureResult>
  async captureMultiple(page: Page, selectors: string[]): Promise<CaptureResult[]>
  private async stabilizePage(page: Page): Promise<void>
  private async maskElements(page: Page, selectors: string[]): Promise<void>
}
```

**Key Features**:
- **Page Stabilization**: Wait for fonts, animations, and dynamic content
- **Element Masking**: Hide dynamic content (timestamps, ads) for consistent comparisons
- **Multi-target Capture**: Support viewport, full page, and element-specific screenshots
- **Metadata Enrichment**: Capture context for analysis (device, viewport, timing)

### 2. Baseline Storage Manager (`src/visual/baseline.ts`)

**Responsibility**: Manage baseline images with Git integration and version control.

```typescript
interface BaselineMetadata {
  id: string;
  branch: string;
  commit: string;
  url: string;
  selector?: string;
  device?: string;
  createdAt: Date;
  filePath: string;
  hash: string;
}

interface BaselineStrategy {
  type: 'branch' | 'commit' | 'manual';
  reference: string; // branch name, commit hash, or baseline ID
}

class BaselineManager {
  async getBaseline(url: string, selector?: string, strategy?: BaselineStrategy): Promise<BaselineMetadata | null>
  async setBaseline(capture: CaptureResult, metadata: Partial<BaselineMetadata>): Promise<BaselineMetadata>
  async updateBaseline(id: string, capture: CaptureResult): Promise<BaselineMetadata>
  async listBaselines(filters?: BaselineFilters): Promise<BaselineMetadata[]>
  async cleanupOldBaselines(retentionDays: number): Promise<number>

  // Git integration
  async syncWithGit(): Promise<void>
  async detectBranchBaselines(): Promise<BaselineMetadata[]>
}
```

**Storage Structure**:
```
.iris/baselines/
├── main/
│   ├── homepage_viewport_desktop.png
│   ├── homepage_viewport_mobile.png
│   └── metadata.json
├── feature/new-header/
│   ├── homepage_viewport_desktop.png
│   └── metadata.json
└── index.db (SQLite index for fast queries)
```

### 3. Visual Diff Engine (`src/visual/diff.ts`)

**Responsibility**: Multi-stage comparison combining pixel analysis with AI semantic understanding.

```typescript
interface DiffOptions {
  threshold: number; // 0-1, pixel difference tolerance
  semanticAnalysis: boolean;
  regionWeights?: RegionWeight[];
  ignoreAntialiasing: boolean;
}

interface RegionWeight {
  selector: string;
  weight: number; // Multiplier for this region's importance
  description: string;
}

interface DiffResult {
  overall: {
    pixelDifference: number; // 0-1
    semanticSimilarity?: number; // 0-1 (higher = more similar)
    severity: 'none' | 'minor' | 'moderate' | 'breaking';
  };
  regions: RegionDiff[];
  artifacts: {
    baseline: string;
    candidate: string;
    diff: string;
    heatmap?: string;
  };
}

interface RegionDiff {
  selector: string;
  pixelDifference: number;
  semanticSimilarity?: number;
  classification: string; // 'text-reflow', 'color-change', 'layout-shift', etc.
  severity: 'none' | 'minor' | 'moderate' | 'breaking';
  boundingBox: { x: number; y: number; width: number; height: number };
}

class VisualDiffEngine {
  async compare(baseline: Buffer, candidate: Buffer, options: DiffOptions): Promise<DiffResult>
  async analyzeRegions(baseline: Buffer, candidate: Buffer, page: Page): Promise<RegionDiff[]>
  private async pixelDiff(baseline: Buffer, candidate: Buffer): Promise<PixelDiffResult>
  private async semanticAnalysis(baseline: Buffer, candidate: Buffer): Promise<number>
  private async classifyDifference(region: RegionDiff, context: PageContext): Promise<string>
}
```

**Analysis Pipeline**:
1. **Pixel Comparison**: SSIM/structural similarity for basic difference detection
2. **Region Segmentation**: Identify meaningful UI regions (header, nav, content, footer)
3. **Semantic Analysis**: AI-powered understanding of visual changes
4. **Classification**: Categorize changes (layout, color, content, etc.)
5. **Severity Assignment**: Weight by region importance and change type

### 4. AI Visual Classifier (`src/visual/ai-classifier.ts`)

**Responsibility**: Leverage AI models for semantic understanding of visual changes.

```typescript
interface VisualAnalysisRequest {
  baselineImage: Buffer;
  candidateImage: Buffer;
  context: {
    url: string;
    pageType?: 'landing' | 'form' | 'dashboard' | 'product';
    previousChanges?: string[]; // Historical context
  };
}

interface VisualAnalysisResponse {
  semanticSimilarity: number; // 0-1
  changeDescription: string;
  changeType: 'layout' | 'color' | 'content' | 'typography' | 'interactive';
  intentional: boolean; // Likelihood this is intentional design change
  confidence: number; // 0-1
  reasoning: string;
}

class AIVisualClassifier {
  async analyzeChange(request: VisualAnalysisRequest): Promise<VisualAnalysisResponse>
  async batchAnalyze(requests: VisualAnalysisRequest[]): Promise<VisualAnalysisResponse[]>
  private async prepareImagesForAI(baseline: Buffer, candidate: Buffer): Promise<PreparedImages>
  private async callVisionModel(images: PreparedImages, context: any): Promise<VisionModelResponse>
}
```

**AI Model Integration**:
- **OpenAI GPT-4V**: Primary vision model for semantic analysis
- **Claude 3.5 Sonnet**: Alternative vision model for comparison
- **Local Options**: Ollama + LLaVA for privacy-conscious deployments
- **Fallback**: Rule-based classification when AI unavailable

### 5. Report Generator (`src/visual/reporter.ts`)

**Responsibility**: Generate comprehensive visual diff reports in multiple formats.

```typescript
interface ReportOptions {
  format: 'html' | 'json' | 'markdown' | 'junit';
  includeArtifacts: boolean;
  groupBy: 'page' | 'severity' | 'changeType';
  template?: string;
}

interface VisualReport {
  summary: {
    totalPages: number;
    totalDifferences: number;
    severityCounts: Record<string, number>;
    overallStatus: 'passed' | 'failed';
  };
  pages: PageReport[];
  artifacts: string[];
  generatedAt: Date;
}

interface PageReport {
  url: string;
  status: 'passed' | 'failed';
  differences: DiffResult[];
  screenshots: {
    baseline: string;
    candidate: string;
    diff: string;
  };
  metadata: any;
}

class VisualReporter {
  async generateReport(results: DiffResult[], options: ReportOptions): Promise<VisualReport>
  async renderHTML(report: VisualReport, template?: string): Promise<string>
  async renderJUnit(report: VisualReport): Promise<string>
  private async copyArtifacts(artifacts: string[], outputDir: string): Promise<void>
}
```

---

## CLI Integration

### New Command: `iris visual-diff`

```bash
# Basic usage
iris visual-diff

# Specific pages
iris visual-diff --pages "/, /login, /dashboard"

# Custom baseline
iris visual-diff --baseline main --pages "/product/*"

# Semantic analysis enabled
iris visual-diff --semantic --threshold 0.05

# Device-specific testing
iris visual-diff --devices "desktop,mobile,tablet"

# Output format
iris visual-diff --format html --output ./visual-report.html

# CI-friendly mode
iris visual-diff --fail-on breaking --format junit
```

**Options**:
- `--pages <patterns>`: Page patterns to test (default: current page)
- `--baseline <ref>`: Git reference for baseline (default: main branch)
- `--semantic`: Enable AI semantic analysis (requires API key)
- `--threshold <number>`: Pixel difference threshold (0-1, default: 0.1)
- `--devices <list>`: Device types for responsive testing
- `--exclude <selectors>`: CSS selectors to exclude from comparison
- `--mask <selectors>`: CSS selectors to mask (timestamps, ads)
- `--format <type>`: Output format (html|json|markdown|junit)
- `--output <path>`: Output file path
- `--fail-on <severity>`: Exit code 1 on specified severity or higher
- `--update-baseline`: Update baseline with current screenshots

### Integration with Existing Commands

**Enhanced `iris run` command**:
```bash
# Include visual assertion in natural language commands
iris run "navigate to /dashboard and verify no visual regressions"
iris run "click menu button and check layout stability"
```

**Enhanced `iris watch` command**:
```bash
# Auto-run visual diff on file changes
iris watch --visual-diff --pages "/dashboard"
iris watch src/components --instruction "visual diff current page"
```

---

## Configuration Extensions

### New Configuration Section

```json
{
  "visual": {
    "enabled": true,
    "baseline": {
      "strategy": "branch",
      "reference": "main",
      "autoUpdate": false
    },
    "capture": {
      "animations": "disabled",
      "waitForFonts": true,
      "stabilizationDelay": 500,
      "fullPage": true
    },
    "comparison": {
      "pixelThreshold": 0.1,
      "semanticAnalysis": true,
      "ignoreAntialiasing": true,
      "regionWeights": [
        {"selector": "header", "weight": 1.5, "description": "Site header"},
        {"selector": ".cta-button", "weight": 2.0, "description": "Call-to-action buttons"},
        {"selector": "footer", "weight": 0.5, "description": "Site footer"}
      ]
    },
    "reporting": {
      "format": "html",
      "includeArtifacts": true,
      "outputDir": ".iris/visual-reports"
    },
    "ai": {
      "provider": "openai",
      "model": "gpt-4-vision-preview",
      "maxTokens": 1000,
      "enableSemanticAnalysis": true
    }
  }
}
```

---

## Database Schema Extensions

### New Tables

```sql
-- Extend existing visual_diffs table from Phase 1
ALTER TABLE visual_diffs ADD COLUMN baseline_id TEXT;
ALTER TABLE visual_diffs ADD COLUMN change_type TEXT;
ALTER TABLE visual_diffs ADD COLUMN intentional BOOLEAN DEFAULT FALSE;
ALTER TABLE visual_diffs ADD COLUMN ai_confidence REAL;
ALTER TABLE visual_diffs ADD COLUMN change_description TEXT;

-- New tables for Phase 2
CREATE TABLE baselines (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  selector TEXT,
  device TEXT,
  branch TEXT NOT NULL,
  commit TEXT NOT NULL,
  file_path TEXT NOT NULL,
  hash TEXT NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(url, selector, device, branch)
);

CREATE TABLE visual_reports (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  format TEXT NOT NULL,
  file_path TEXT NOT NULL,
  summary_json TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(run_id) REFERENCES test_runs(id)
);

CREATE TABLE region_diffs (
  id TEXT PRIMARY KEY,
  diff_id TEXT,
  selector TEXT NOT NULL,
  pixel_difference REAL NOT NULL,
  semantic_similarity REAL,
  classification TEXT,
  severity TEXT NOT NULL,
  bounding_box_json TEXT,
  FOREIGN KEY(diff_id) REFERENCES visual_diffs(id)
);

-- Indexes for performance
CREATE INDEX idx_baselines_url_branch ON baselines(url, branch);
CREATE INDEX idx_visual_diffs_baseline ON visual_diffs(baseline_id);
CREATE INDEX idx_region_diffs_diff ON region_diffs(diff_id);
```

---

## File Structure Extensions

### New Directory Structure

```
/iris
  /src
    /visual                 # Phase 2 visual regression module
      capture.ts           # Screenshot capture engine
      baseline.ts          # Baseline management
      diff.ts             # Visual comparison engine
      ai-classifier.ts    # AI-powered analysis
      reporter.ts         # Report generation
      types.ts            # TypeScript interfaces
      utils.ts            # Shared utilities
      index.ts            # Module exports
    /visual/__tests__      # Visual module tests
      capture.test.ts
      baseline.test.ts
      diff.test.ts
      ai-classifier.test.ts
      reporter.test.ts
  /.iris                  # IRIS workspace directory
    /baselines            # Baseline images storage
      /main               # Main branch baselines
      /feature-*          # Feature branch baselines
    /visual-reports       # Generated reports
    /artifacts            # Test artifacts (diffs, screenshots)
```

---

## API Specifications

### Visual Testing API

**Internal TypeScript API**:
```typescript
// Core visual testing interface
interface VisualTester {
  captureBaseline(url: string, options?: CaptureOptions): Promise<BaselineMetadata>;
  runVisualTest(url: string, options?: TestOptions): Promise<TestResult>;
  updateBaseline(baselineId: string): Promise<BaselineMetadata>;
  generateReport(results: TestResult[], options?: ReportOptions): Promise<VisualReport>;
}

// Configuration interface
interface VisualTestConfig {
  pages: string[];
  baseline: BaselineStrategy;
  capture: CaptureConfig;
  comparison: DiffOptions;
  reporting: ReportOptions;
}
```

**JSON-RPC Extensions** (for external integrations):
```typescript
// New methods for Phase 2
interface VisualRPCMethods {
  'visual.capture': (url: string, options?: CaptureOptions) => Promise<CaptureResult>;
  'visual.compare': (candidateId: string, baselineId: string) => Promise<DiffResult>;
  'visual.generateReport': (testRunId: string, format: string) => Promise<string>;
  'visual.getBaselines': (filters?: BaselineFilters) => Promise<BaselineMetadata[]>;
  'visual.updateBaseline': (baselineId: string) => Promise<BaselineMetadata>;
}
```

---

## Error Handling & Edge Cases

### Error Categories

1. **Capture Errors** (Exit Code 3):
   - Page load timeout
   - Element not found for targeted screenshots
   - Browser crash during capture

2. **Baseline Errors** (Exit Code 2):
   - Missing baseline for comparison
   - Corrupted baseline files
   - Git integration failures

3. **Analysis Errors** (Exit Code 3):
   - AI service unavailable
   - Image processing failures
   - Invalid comparison parameters

4. **Report Generation Errors** (Exit Code 3):
   - Insufficient disk space
   - Template rendering failures
   - Artifact copy failures

### Graceful Degradation

```typescript
class VisualTestRunner {
  async runWithFallbacks(config: VisualTestConfig): Promise<TestResult> {
    try {
      return await this.runFullTest(config);
    } catch (error) {
      if (error instanceof AIServiceError && config.comparison.semanticAnalysis) {
        // Fallback to pixel-only comparison
        console.warn('AI analysis unavailable, falling back to pixel comparison');
        return await this.runPixelOnlyTest(config);
      }

      if (error instanceof BaselineNotFoundError) {
        // Offer to create baseline
        if (config.baseline.autoCreate) {
          return await this.createBaselineAndTest(config);
        }
      }

      throw error;
    }
  }
}
```

---

## Performance Optimization

### Capture Optimization
- **Parallel Processing**: Capture multiple pages/devices simultaneously
- **Image Compression**: Optimize PNG compression for storage
- **Incremental Capture**: Only capture changed regions when possible
- **Caching**: Cache stable elements between test runs

### Comparison Optimization
- **Early Exit**: Stop comparison when differences exceed threshold
- **Region Prioritization**: Compare critical regions first
- **Batch Processing**: Process multiple comparisons in parallel
- **Diff Caching**: Cache diff results keyed by image hashes

### Storage Optimization
- **Baseline Cleanup**: Automatic cleanup of old baselines
- **Deduplication**: Share identical baselines across branches
- **Compression**: Compress baseline storage with lossless algorithms
- **Lazy Loading**: Load baseline images only when needed

---

## Security & Privacy Considerations

### Image Data Handling
- **Local Storage**: Images stored locally by default
- **Redaction**: Automatic PII detection and masking
- **Encryption**: Optional encryption for sensitive baselines
- **Access Control**: File system permissions for baseline directory

### AI Service Integration
- **Data Minimization**: Send only necessary image data to AI services
- **Opt-out**: Always allow disabling of AI analysis
- **Local Options**: Support for local AI models via Ollama
- **Audit Logging**: Track all AI service calls and data sent

---

## Testing Strategy

### Unit Tests
- **Capture Engine**: Mock Playwright page interactions
- **Diff Engine**: Golden image comparisons with known differences
- **AI Classifier**: Mock AI responses for deterministic testing
- **Baseline Manager**: File system mocking and Git integration

### Integration Tests
- **End-to-End**: Real browser automation with test applications
- **Multi-Device**: Responsive testing across device types
- **Git Workflow**: Branch switching and baseline management
- **Report Generation**: Full report rendering and artifact creation

### Performance Tests
- **Load Testing**: Multiple concurrent visual tests
- **Memory Usage**: Large image processing and storage
- **Disk Usage**: Baseline storage growth over time
- **Network**: AI service call latency and failures

---

## Migration Strategy

### Phase 1 Compatibility
- **Zero Breaking Changes**: All Phase 1 functionality preserved
- **Additive Features**: New visual testing capabilities as optional extensions
- **Configuration Evolution**: Extend existing config schema without conflicts
- **Database Migration**: Automatic schema updates with backward compatibility

### Migration Path
1. **Install Dependencies**: Add image processing and AI libraries
2. **Database Migration**: Extend schema with new visual tables
3. **Configuration Update**: Add visual section to existing config
4. **CLI Extension**: Register new `visual-diff` command
5. **Baseline Initialization**: Create initial baselines for existing tests

---

## Success Metrics

### Technical Metrics
- **Accuracy**: >95% correct classification of intentional vs. unintentional changes
- **Performance**: <10s for full-page visual diff including AI analysis
- **Reliability**: <1% false positive rate for regression detection
- **Coverage**: Support for all major UI patterns and responsive designs

### User Experience Metrics
- **Setup Time**: <5 minutes from installation to first visual test
- **Actionability**: >90% of flagged issues provide clear remediation guidance
- **CI Integration**: <30s overhead in typical CI pipeline
- **Storage Efficiency**: <100MB baseline storage for typical project

---

## Future Enhancements (Phase 3+)

### Advanced AI Features
- **Cross-browser Normalization**: AI-powered handling of browser-specific rendering differences
- **Auto-healing Baselines**: Intelligent baseline updates for intentional design changes
- **Predictive Analysis**: ML models trained on historical data to predict likely regressions

### Integration Enhancements
- **Design System Integration**: Automatic validation against design tokens and component libraries
- **Figma Sync**: Compare implementations against design files
- **Accessibility Overlay**: Combine visual and accessibility testing in unified reports

### Enterprise Features
- **Cloud Baseline Storage**: Shared baselines across team members and CI/CD
- **Advanced Analytics**: Regression trend analysis and impact assessment
- **Custom Notifications**: Slack/Teams integration for visual regression alerts

---

## Implementation Roadmap

### Week 1-2: Foundation
- [ ] Core visual module structure and types
- [ ] Basic screenshot capture with Playwright integration
- [ ] File-based baseline storage implementation
- [ ] Simple pixel-diff comparison engine

### Week 3-4: Intelligence Layer
- [ ] AI classifier integration with OpenAI/Claude vision models
- [ ] Semantic analysis pipeline implementation
- [ ] Region-based analysis and weighting
- [ ] Advanced diff classification algorithms

### Week 5-6: CLI Integration
- [ ] `iris visual-diff` command implementation
- [ ] Configuration system integration
- [ ] Database schema updates and migrations
- [ ] Enhanced `iris run` with visual assertions

### Week 7-8: Reporting & Polish
- [ ] HTML/JSON report generation
- [ ] CI/CD integration patterns
- [ ] Performance optimization and caching
- [ ] Comprehensive test coverage and documentation

**Estimated Completion**: 8 weeks with 2-3 engineers
**Ready for Beta**: End of Week 6
**Production Ready**: End of Week 8

---

This architecture provides a solid foundation for Phase 2 visual regression testing while maintaining the high code quality and architectural principles established in Phase 1. The design emphasizes practical developer needs while incorporating cutting-edge AI capabilities to solve real-world visual testing challenges.