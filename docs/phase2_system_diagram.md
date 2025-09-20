# Phase 2 System Architecture Diagram

## High-Level System Flow

```mermaid
graph TB
    subgraph "Phase 1 Foundation"
        CLI[CLI Commands]
        Browser[Browser Engine]
        Config[Configuration]
        DB[(SQLite Database)]
        AI[AI Client]
    end

    subgraph "Phase 2 Visual Regression"
        Capture[Visual Capture Engine]
        Baseline[Baseline Manager]
        Diff[Diff Engine]
        Classifier[AI Visual Classifier]
        Reporter[Report Generator]
    end

    subgraph "Storage Layer"
        Images[(.iris/baselines/)]
        Reports[(.iris/visual-reports/)]
        Artifacts[(.iris/artifacts/)]
    end

    subgraph "External Services"
        Git[(Git Repository)]
        OpenAI[OpenAI GPT-4V]
        Claude[Claude Vision]
        Ollama[Local Ollama]
    end

    CLI --> Capture
    Browser --> Capture
    Config --> Capture
    Config --> Baseline
    Config --> Diff
    Config --> Classifier

    Capture --> Baseline
    Capture --> Diff
    Baseline --> Git
    Baseline --> Images

    Diff --> Classifier
    Classifier --> AI
    Classifier --> OpenAI
    Classifier --> Claude
    Classifier --> Ollama

    Diff --> Reporter
    Reporter --> Reports
    Reporter --> Artifacts

    Capture --> DB
    Baseline --> DB
    Diff --> DB
    Reporter --> DB

    style "Phase 2 Visual Regression" fill:#e1f5fe
    style "Phase 1 Foundation" fill:#f3e5f5
    style "Storage Layer" fill:#fff3e0
    style "External Services" fill:#e8f5e8
```

## Detailed Component Architecture

```mermaid
graph LR
    subgraph "Visual Capture Pipeline"
        A[Page Load] --> B[Stabilization]
        B --> C[Element Masking]
        C --> D[Screenshot Capture]
        D --> E[Metadata Collection]
        E --> F[Hash Generation]
    end

    subgraph "Baseline Management"
        G[Git Integration] --> H[Branch Detection]
        H --> I[Baseline Lookup]
        I --> J[File Storage]
        J --> K[Metadata Index]
    end

    subgraph "Diff Analysis Pipeline"
        L[Pixel Comparison] --> M[Region Segmentation]
        M --> N[Semantic Analysis]
        N --> O[Classification]
        O --> P[Severity Assignment]
    end

    subgraph "AI Analysis Flow"
        Q[Image Preprocessing] --> R[Vision Model Call]
        R --> S[Response Processing]
        S --> T[Confidence Scoring]
        T --> U[Change Classification]
    end

    F --> I
    K --> L
    P --> Q
    U --> V[Report Generation]

    style "Visual Capture Pipeline" fill:#ffebee
    style "Baseline Management" fill:#e3f2fd
    style "Diff Analysis Pipeline" fill:#f1f8e9
    style "AI Analysis Flow" fill:#fff8e1
```

## Data Flow Architecture

```mermaid
sequenceDiagram
    participant U as User
    participant CLI as CLI Command
    participant CE as Capture Engine
    participant BM as Baseline Manager
    participant DE as Diff Engine
    participant AC as AI Classifier
    participant RG as Report Generator
    participant FS as File System
    participant DB as Database

    U->>CLI: iris visual-diff --pages "/home"
    CLI->>CE: captureScreenshot(url, options)
    CE->>FS: Save candidate image
    CE->>BM: getBaseline(url, branch)
    BM->>FS: Load baseline image
    BM-->>CE: baseline metadata
    CE->>DE: compare(baseline, candidate)
    DE->>AC: analyzeChange(images, context)
    AC-->>DE: semantic analysis result
    DE->>DB: Store diff results
    DE->>RG: generateReport(diffResults)
    RG->>FS: Save HTML report
    RG-->>CLI: report file path
    CLI-->>U: Visual diff complete
```

## Integration Points

```mermaid
graph TD
    subgraph "Phase 1 Integration"
        A[CLI Framework] --> B[Enhanced Commands]
        C[Browser Module] --> D[Screenshot APIs]
        E[Config System] --> F[Visual Settings]
        G[Database] --> H[Extended Schema]
        I[AI Client] --> J[Vision Models]
    end

    subgraph "New Phase 2 Modules"
        B --> K[iris visual-diff]
        D --> L[Visual Capture]
        F --> M[Baseline Config]
        H --> N[Visual Tables]
        J --> O[AI Classifier]
    end

    subgraph "External Integrations"
        P[Git Workflow] --> M
        Q[CI/CD Pipeline] --> K
        R[Report Viewers] --> S[Generated Reports]
    end

    K --> L
    L --> M
    L --> N
    L --> O
    O --> S

    style "Phase 1 Integration" fill:#e8eaf6
    style "New Phase 2 Modules" fill:#e0f2f1
    style "External Integrations" fill:#fce4ec
```

## File System Organization

```
.iris/
├── baselines/                 # Git-aware baseline storage
│   ├── main/                 # Main branch baselines
│   │   ├── homepage_desktop.png
│   │   ├── homepage_mobile.png
│   │   └── metadata.json
│   ├── feature-branch/       # Feature branch baselines
│   └── index.db             # Fast baseline lookup
├── visual-reports/           # Generated reports
│   ├── 2025-09-19_143022/   # Timestamped reports
│   │   ├── index.html       # Main report
│   │   ├── assets/          # CSS, JS, images
│   │   └── artifacts/       # Diff images
│   └── latest -> 2025-09-19_143022/
├── artifacts/                # Test run artifacts
│   ├── screenshots/         # Captured screenshots
│   ├── diffs/              # Difference images
│   └── metadata/           # Run metadata
└── config/
    ├── visual.json         # Visual testing config
    └── templates/          # Report templates
```

## API Layer Design

```mermaid
graph TB
    subgraph "Public CLI API"
        A[iris visual-diff]
        B[iris run with --visual]
        C[iris watch --visual-diff]
    end

    subgraph "Internal TypeScript API"
        D[VisualTester Interface]
        E[CaptureEngine]
        F[BaselineManager]
        G[DiffEngine]
        H[AIClassifier]
        I[ReportGenerator]
    end

    subgraph "JSON-RPC Extensions"
        J[visual.capture]
        K[visual.compare]
        L[visual.generateReport]
        M[visual.getBaselines]
    end

    A --> D
    B --> D
    C --> D

    D --> E
    D --> F
    D --> G
    D --> H
    D --> I

    J --> E
    K --> G
    L --> I
    M --> F

    style "Public CLI API" fill:#f3e5f5
    style "Internal TypeScript API" fill:#e1f5fe
    style "JSON-RPC Extensions" fill:#fff3e0
```

## Error Handling Flow

```mermaid
graph TD
    A[Visual Test Start] --> B{Capture Success?}
    B -->|No| C[Capture Error Handler]
    B -->|Yes| D{Baseline Found?}
    D -->|No| E[Create Baseline Option]
    D -->|Yes| F{Diff Analysis Success?}
    F -->|No| G[Analysis Error Handler]
    F -->|Yes| H{AI Available?}
    H -->|No| I[Pixel-Only Fallback]
    H -->|Yes| J[Full AI Analysis]
    I --> K[Generate Report]
    J --> K
    K --> L{Report Success?}
    L -->|No| M[Report Error Handler]
    L -->|Yes| N[Success Exit]

    C --> O[Log Error & Exit]
    E --> P{Auto-Create?}
    P -->|Yes| Q[Create Baseline]
    P -->|No| R[Exit with Instructions]
    G --> S[Fallback to Basic Diff]
    M --> T[Partial Report & Warning]

    Q --> F
    S --> K
    T --> U[Warning Exit]

    style N fill:#c8e6c9
    style O fill:#ffcdd2
    style R fill:#ffcdd2
    style U fill:#fff3c4
```

This visual architecture provides a comprehensive view of how Phase 2 visual regression testing integrates with the existing Phase 1 foundation while adding sophisticated new capabilities for intelligent visual analysis.