# Phase 2 To-Do List - Visual Regression Testing

This list breaks down the core tasks needed to complete **Phase 2 – Enhanced Testing (Visual Regression & Accessibility)** as defined in the Phase 2 architecture and development plan.

**Target Timeline:** 8 weeks (2 engineers)
**Phase 2 Status:** 🟡 Ready for Implementation

---

## Week 1-2: Foundation & Core Infrastructure

### 1. Project Structure & Dependencies

+ [ ] **Setup Phase 2 module structure**
  - [ ] Create `/src/visual/` directory structure
  - [ ] Create `/src/visual/__tests__/` directory
  - [ ] Setup TypeScript exports in `src/visual/index.ts`
  - [ ] Update main `src/index.ts` to export visual module

+ [ ] **Add required dependencies**
  - [ ] Add image processing library (`sharp` or `jimp`)
  - [ ] Add SSIM comparison library (`image-ssim`)
  - [ ] Add Git integration library (`simple-git`)
  - [ ] Update package.json with new dependencies
  - [ ] Install and verify all dependencies compile

+ [ ] **Database schema extensions**
  - [ ] Create migration script for new visual tables
  - [ ] Implement `baselines` table schema
  - [ ] Implement `visual_reports` table schema
  - [ ] Implement `region_diffs` table schema
  - [ ] Extend existing `visual_diffs` table with new columns
  - [ ] Create database indexes for performance
  - [ ] Test migration script with existing Phase 1 data

### 2. TypeScript Interfaces & Types

+ [ ] **Core visual types definition** (`src/visual/types.ts`)
  - [ ] Define `CaptureConfig` interface
  - [ ] Define `CaptureResult` interface
  - [ ] Define `BaselineMetadata` interface
  - [ ] Define `DiffOptions` interface
  - [ ] Define `DiffResult` interface
  - [ ] Define `VisualAnalysisRequest` interface
  - [ ] Define `VisualAnalysisResponse` interface
  - [ ] Define `VisualReport` interfaces
  - [ ] Export all types from visual module

+ [ ] **Configuration schema extensions**
  - [ ] Extend `IrisConfig` with `visual` section
  - [ ] Define `VisualConfig` interface with all options
  - [ ] Update config validation to include visual settings
  - [ ] Add default visual configuration values
  - [ ] Test configuration loading with visual settings

### 3. Visual Capture Engine Foundation

+ [ ] **Basic screenshot capture** (`src/visual/capture.ts`)
  - [ ] Implement `VisualCaptureEngine` class structure
  - [ ] Create `capture()` method for single screenshots
  - [ ] Create `captureMultiple()` method for batch captures
  - [ ] Implement viewport and full-page capture modes
  - [ ] Add element-specific screenshot capability
  - [ ] Generate screenshot metadata (timestamp, hash, viewport)

+ [ ] **Page stabilization utilities**
  - [ ] Implement `stabilizePage()` method
  - [ ] Add font loading detection and waiting
  - [ ] Add animation disabling capability
  - [ ] Implement configurable stabilization delay
  - [ ] Add network idle detection for AJAX completion

+ [ ] **Element masking functionality**
  - [ ] Implement `maskElements()` method
  - [ ] Add CSS selector-based masking
  - [ ] Create masking overlay generation
  - [ ] Add configuration for default mask selectors
  - [ ] Test masking with various element types

### 4. Basic File System Storage

+ [ ] **Baseline directory structure**
  - [ ] Create `.iris/baselines/` directory management
  - [ ] Implement branch-based directory organization
  - [ ] Create metadata.json file handling
  - [ ] Add file cleanup and maintenance utilities
  - [ ] Implement file system permissions setup

+ [ ] **Image file operations**
  - [ ] Implement image file saving with compression
  - [ ] Add image file loading and validation
  - [ ] Create image hash generation for deduplication
  - [ ] Implement file naming conventions
  - [ ] Add image format validation and conversion

---

## Week 3-4: Core Diff Engine & AI Integration

### 5. Visual Diff Engine Implementation

+ [ ] **Pixel-level comparison** (`src/visual/diff.ts`)
  - [ ] Implement `VisualDiffEngine` class structure
  - [ ] Create `compare()` method for image comparison
  - [ ] Integrate SSIM structural similarity comparison
  - [ ] Implement pixel difference calculation
  - [ ] Add anti-aliasing tolerance handling
  - [ ] Generate diff heatmap visualization

+ [ ] **Region-based analysis**
  - [ ] Implement `analyzeRegions()` method
  - [ ] Add UI region detection (header, nav, content, footer)
  - [ ] Create bounding box calculation for regions
  - [ ] Implement region-specific difference scoring
  - [ ] Add configurable region weight system

+ [ ] **Severity classification system**
  - [ ] Implement severity calculation algorithm
  - [ ] Add change type classification (layout, color, content)
  - [ ] Create severity thresholds configuration
  - [ ] Implement region importance weighting
  - [ ] Add break/pass decision logic

+ [ ] **Diff artifact generation**
  - [ ] Create difference overlay image generation
  - [ ] Implement side-by-side comparison images
  - [ ] Add heatmap visualization for differences
  - [ ] Create annotated diff images with region highlights
  - [ ] Implement artifact file management

### 6. AI Visual Classifier Integration

+ [ ] **AI provider integration** (`src/visual/ai-classifier.ts`)
  - [ ] Implement `AIVisualClassifier` class structure
  - [ ] Create OpenAI GPT-4V integration
  - [ ] Add Claude 3.5 Sonnet vision integration
  - [ ] Implement Ollama local model support
  - [ ] Add provider fallback and error handling

+ [ ] **Image preprocessing for AI**
  - [ ] Implement `prepareImagesForAI()` method
  - [ ] Add image resizing for model input requirements
  - [ ] Create image encoding for API transmission
  - [ ] Implement image quality optimization
  - [ ] Add batch processing capability

+ [ ] **AI analysis pipeline**
  - [ ] Create `analyzeChange()` method for single comparisons
  - [ ] Implement `batchAnalyze()` for multiple comparisons
  - [ ] Add context injection for better AI understanding
  - [ ] Create response parsing and validation
  - [ ] Implement confidence scoring normalization

+ [ ] **Change classification logic**
  - [ ] Implement intentional vs. unintentional change detection
  - [ ] Add change type classification (layout, color, content, typography)
  - [ ] Create semantic similarity scoring
  - [ ] Implement reasoning extraction from AI responses
  - [ ] Add classification confidence metrics

### 7. Baseline Management System

+ [ ] **Git integration** (`src/visual/baseline.ts`)
  - [ ] Implement `BaselineManager` class structure
  - [ ] Add Git branch detection using `simple-git`
  - [ ] Create commit hash extraction for baseline versioning
  - [ ] Implement branch-based baseline lookup
  - [ ] Add Git repository validation

+ [ ] **Baseline CRUD operations**
  - [ ] Implement `getBaseline()` method with strategy support
  - [ ] Create `setBaseline()` method for new baseline creation
  - [ ] Add `updateBaseline()` method for baseline updates
  - [ ] Implement `listBaselines()` with filtering
  - [ ] Create `cleanupOldBaselines()` maintenance method

+ [ ] **Baseline strategy implementation**
  - [ ] Add branch-based baseline strategy
  - [ ] Implement commit-based baseline strategy
  - [ ] Create manual baseline strategy
  - [ ] Add automatic baseline creation options
  - [ ] Implement baseline validation and integrity checks

---

## Week 5-6: CLI Integration & Configuration

### 8. CLI Command Implementation

+ [ ] **New `iris visual-diff` command** (update `src/cli.ts`)
  - [ ] Register new visual-diff command with commander.js
  - [ ] Implement command option parsing (--pages, --baseline, --semantic)
  - [ ] Add device and viewport option handling
  - [ ] Create threshold and sensitivity configuration
  - [ ] Implement output format selection

+ [ ] **Visual diff execution pipeline**
  - [ ] Create main visual diff workflow orchestration
  - [ ] Implement page pattern matching and URL resolution
  - [ ] Add progress reporting for multi-page tests
  - [ ] Create result aggregation across multiple pages
  - [ ] Implement exit code handling based on severity

+ [ ] **Enhanced existing commands**
  - [ ] Extend `iris run` with visual assertion support
  - [ ] Add `--visual` flag to run command
  - [ ] Enhance `iris watch` with visual diff triggering
  - [ ] Add visual change notifications to watch mode
  - [ ] Integrate visual results with existing test run storage

+ [ ] **CLI user experience improvements**
  - [ ] Add colored output for visual diff results
  - [ ] Implement progress spinners for long operations
  - [ ] Create summary statistics display
  - [ ] Add interactive baseline update prompts
  - [ ] Implement helpful error messages and suggestions

### 9. Configuration System Integration

+ [ ] **Visual configuration loading**
  - [ ] Integrate visual config with existing config system
  - [ ] Add environment variable support for visual settings
  - [ ] Implement configuration validation for visual options
  - [ ] Create default configuration generation
  - [ ] Add configuration file examples and documentation

+ [ ] **Dynamic configuration handling**
  - [ ] Implement runtime configuration overrides
  - [ ] Add CLI flag to configuration mapping
  - [ ] Create configuration inheritance (global → project → command)
  - [ ] Implement sensitive setting handling (API keys)
  - [ ] Add configuration validation error reporting

### 10. Database Integration

+ [ ] **Visual test result storage**
  - [ ] Implement visual test run persistence
  - [ ] Add baseline metadata storage and indexing
  - [ ] Create visual diff result storage
  - [ ] Implement region diff detail storage
  - [ ] Add report metadata tracking

+ [ ] **Database query optimization**
  - [ ] Create indexed queries for baseline lookup
  - [ ] Implement efficient visual test history queries
  - [ ] Add baseline cleanup query optimization
  - [ ] Create performance monitoring for database operations
  - [ ] Implement query result caching where appropriate

---

## Week 7-8: Reporting, Optimization & Testing

### 11. Report Generation System

+ [ ] **HTML report generator** (`src/visual/reporter.ts`)
  - [ ] Implement `VisualReporter` class structure
  - [ ] Create `generateReport()` method for multi-format support
  - [ ] Implement HTML template rendering
  - [ ] Add interactive diff viewer in HTML reports
  - [ ] Create responsive design for report viewing

+ [ ] **Multi-format export**
  - [ ] Implement JSON report export
  - [ ] Add Markdown report generation
  - [ ] Create JUnit XML export for CI/CD
  - [ ] Implement CSV export for data analysis
  - [ ] Add custom template support

+ [ ] **Report artifacts management**
  - [ ] Implement artifact copying and organization
  - [ ] Create relative path handling in reports
  - [ ] Add artifact compression for large reports
  - [ ] Implement artifact cleanup policies
  - [ ] Create report sharing and distribution utilities

+ [ ] **Report visualization features**
  - [ ] Add side-by-side image comparison viewer
  - [ ] Implement diff overlay visualization
  - [ ] Create severity filtering and grouping
  - [ ] Add trend analysis for historical data
  - [ ] Implement report navigation and search

### 12. Performance Optimization

+ [ ] **Capture performance optimization**
  - [ ] Implement parallel screenshot processing
  - [ ] Add screenshot caching for unchanged pages
  - [ ] Create incremental capture for partial updates
  - [ ] Implement smart retry mechanisms
  - [ ] Add memory management for large image processing

+ [ ] **Comparison performance optimization**
  - [ ] Implement early exit for large differences
  - [ ] Add diff result caching based on image hashes
  - [ ] Create batch processing for multiple comparisons
  - [ ] Implement region prioritization for faster feedback
  - [ ] Add configurable performance tuning options

+ [ ] **Storage optimization**
  - [ ] Implement image compression without quality loss
  - [ ] Add baseline deduplication across branches
  - [ ] Create automatic cleanup of old artifacts
  - [ ] Implement lazy loading for large image sets
  - [ ] Add storage usage monitoring and reporting

### 13. Error Handling & Edge Cases

+ [ ] **Comprehensive error handling**
  - [ ] Implement capture error recovery (page load failures, timeouts)
  - [ ] Add baseline error handling (missing, corrupted files)
  - [ ] Create AI service error fallback mechanisms
  - [ ] Implement report generation error recovery
  - [ ] Add graceful degradation for all failure modes

+ [ ] **Edge case handling**
  - [ ] Handle dynamic content and timing issues
  - [ ] Implement browser compatibility edge cases
  - [ ] Add network failure and retry logic
  - [ ] Handle file system permission issues
  - [ ] Create disk space and resource constraint handling

+ [ ] **User-friendly error messages**
  - [ ] Create actionable error messages with solutions
  - [ ] Add troubleshooting guides for common issues
  - [ ] Implement error categorization and severity
  - [ ] Add context-aware error suggestions
  - [ ] Create error reporting and diagnostics

### 14. Comprehensive Testing Suite

+ [ ] **Unit tests for all modules**
  - [ ] Test visual capture engine with mocked Playwright
  - [ ] Test baseline manager with mocked Git and filesystem
  - [ ] Test diff engine with golden image datasets
  - [ ] Test AI classifier with mocked provider responses
  - [ ] Test report generator with template validation
  - [ ] Test CLI commands with mocked dependencies

+ [ ] **Integration tests**
  - [ ] End-to-end visual regression workflow tests
  - [ ] Multi-device responsive testing scenarios
  - [ ] Git workflow integration tests (branch switching)
  - [ ] Database migration and schema tests
  - [ ] Configuration loading and validation tests
  - [ ] Error handling and recovery tests

+ [ ] **Performance tests**
  - [ ] Concurrent visual test execution benchmarks
  - [ ] Large image processing memory tests
  - [ ] Baseline storage growth and cleanup tests
  - [ ] AI service latency and timeout tests
  - [ ] Report generation performance tests
  - [ ] Database query performance tests

+ [ ] **Quality assurance**
  - [ ] Code coverage analysis (target >90% for visual module)
  - [ ] Static analysis and linting
  - [ ] TypeScript strict mode compliance
  - [ ] Security audit for file operations and AI integration
  - [ ] Accessibility testing for generated reports
  - [ ] Cross-platform compatibility testing (Windows, macOS, Linux)

---

## Post-Implementation: Documentation & Release Prep

### 15. Documentation & Examples

+ [ ] **Technical documentation**
  - [ ] Update API documentation with visual testing methods
  - [ ] Create visual testing configuration guide
  - [ ] Write troubleshooting guide for common issues
  - [ ] Document AI provider setup and requirements
  - [ ] Create performance tuning guide

+ [ ] **User guides and examples**
  - [ ] Create getting started guide for visual testing
  - [ ] Write best practices guide for baseline management
  - [ ] Create example projects demonstrating visual testing
  - [ ] Write CI/CD integration examples
  - [ ] Create video tutorials for key workflows

+ [ ] **Migration documentation**
  - [ ] Write Phase 1 to Phase 2 migration guide
  - [ ] Document breaking changes (if any)
  - [ ] Create configuration migration utilities
  - [ ] Write database migration troubleshooting guide
  - [ ] Document rollback procedures

### 16. Release Preparation

+ [ ] **Version management**
  - [ ] Update package.json version to 2.0.0
  - [ ] Create release notes for Phase 2
  - [ ] Update CHANGELOG.md with new features
  - [ ] Tag release in Git repository
  - [ ] Update README.md with Phase 2 features

+ [ ] **Quality gates**
  - [ ] Run full test suite and ensure 100% pass rate
  - [ ] Verify code coverage meets targets (>90%)
  - [ ] Complete security audit checklist
  - [ ] Validate performance benchmarks
  - [ ] Test installation and setup process

+ [ ] **Release validation**
  - [ ] Test installation from NPM package
  - [ ] Validate all CLI commands work correctly
  - [ ] Test configuration and setup workflows
  - [ ] Verify examples and documentation accuracy
  - [ ] Conduct user acceptance testing with Phase 2 features

---

## Success Criteria

**Phase 2 will be considered complete when:**

### Technical Criteria
- [ ] All CLI commands execute successfully with proper error handling
- [ ] Visual diff accuracy >95% for intentional vs. unintentional changes
- [ ] Performance target <10s for full-page visual diff with AI analysis
- [ ] False positive rate <1% for regression detection
- [ ] Test coverage >90% for all visual testing modules

### User Experience Criteria
- [ ] Setup time <5 minutes from installation to first visual test
- [ ] Actionable remediation guidance >90% for flagged issues
- [ ] CI pipeline overhead <30 seconds
- [ ] Baseline storage <100MB for typical projects

### Integration Criteria
- [ ] Zero breaking changes to Phase 1 functionality
- [ ] Seamless database migration from Phase 1
- [ ] Backward compatible configuration
- [ ] All Phase 1 tests continue to pass

### Documentation Criteria
- [ ] Complete API documentation for all new interfaces
- [ ] User guides for all major workflows
- [ ] Troubleshooting guides for common issues
- [ ] Example projects demonstrating features
- [ ] Migration guide from Phase 1

---

**Total Estimated Tasks:** 150+ atomic tasks
**Timeline:** 8 weeks (2 engineers working in parallel)
**Current Phase 1 Completion:** ✅ 100% - Ready for Phase 2

This comprehensive task list ensures systematic implementation of Phase 2 visual regression testing while maintaining the high quality standards established in Phase 1.