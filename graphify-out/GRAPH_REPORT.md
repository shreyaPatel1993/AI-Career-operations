# Graph Report - .  (2026-04-13)

## Corpus Check
- Large corpus: 88 files · ~948,452 words. Semantic extraction will be expensive (many Claude tokens). Consider running on a subfolder, or use --no-semantic to run AST-only.

## Summary
- 82 nodes · 127 edges · 11 communities detected
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- [[_COMMUNITY_Community 0|Community 0]]
- [[_COMMUNITY_Community 1|Community 1]]
- [[_COMMUNITY_Community 2|Community 2]]
- [[_COMMUNITY_Community 3|Community 3]]
- [[_COMMUNITY_Community 4|Community 4]]
- [[_COMMUNITY_Community 5|Community 5]]
- [[_COMMUNITY_Community 6|Community 6]]
- [[_COMMUNITY_Community 7|Community 7]]
- [[_COMMUNITY_Community 8|Community 8]]
- [[_COMMUNITY_Community 9|Community 9]]
- [[_COMMUNITY_Community 10|Community 10]]

## God Nodes (most connected - your core abstractions)
1. `PipelineModel` - 29 edges
2. `ViewerModel` - 10 edges
3. `ParseApplications()` - 5 edges
4. `appModel` - 4 edges
5. `statusLabel()` - 4 edges
6. `enrichFromScanHistory()` - 3 edges
7. `normalizeCompany()` - 3 edges
8. `enrichAppURLsByCompany()` - 3 edges
9. `NormalizeStatus()` - 3 edges
10. `NewPipelineModel()` - 2 edges

## Surprising Connections (you probably didn't know these)
- None detected - all connections are within the same source files.

## Communities

### Community 0 - "Community 0"
Cohesion: 0.23
Nodes (14): cleanTableCell(), ComputeMetrics(), enrichAppURLsByCompany(), enrichFromScanHistory(), loadBatchInputURLs(), loadJobURLs(), LoadReportSummary(), normalizeCompany() (+6 more)

### Community 1 - "Community 1"
Cohesion: 0.24
Nodes (2): ViewerClosedMsg, ViewerModel

### Community 2 - "Community 2"
Cohesion: 0.2
Nodes (8): NewPipelineModel(), PipelineClosedMsg, PipelineLoadReportMsg, PipelineOpenReportMsg, PipelineOpenURLMsg, pipelineTab, PipelineUpdateStatusMsg, reportSummary

### Community 3 - "Community 3"
Cohesion: 0.29
Nodes (1): PipelineModel

### Community 4 - "Community 4"
Cohesion: 0.29
Nodes (2): appModel, viewState

### Community 5 - "Community 5"
Cohesion: 0.43
Nodes (0): 

### Community 6 - "Community 6"
Cohesion: 0.38
Nodes (1): statusLabel()

### Community 7 - "Community 7"
Cohesion: 0.38
Nodes (0): 

### Community 8 - "Community 8"
Cohesion: 0.67
Nodes (1): Theme

### Community 9 - "Community 9"
Cohesion: 0.67
Nodes (2): CareerApplication, PipelineMetrics

### Community 10 - "Community 10"
Cohesion: 1.0
Nodes (0): 

## Knowledge Gaps
- **13 isolated node(s):** `viewState`, `ViewerClosedMsg`, `PipelineClosedMsg`, `PipelineOpenReportMsg`, `PipelineOpenURLMsg` (+8 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **Thin community `Community 10`** (2 nodes): `newCatppuccinMocha()`, `catppuccin.go`
  Too small to be a meaningful cluster - may be noise or needs more connections extracted.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `PipelineModel` connect `Community 3` to `Community 2`, `Community 5`, `Community 6`, `Community 7`?**
  _High betweenness centrality (0.173) - this node is a cross-community bridge._
- **Why does `statusLabel()` connect `Community 6` to `Community 2`?**
  _High betweenness centrality (0.004) - this node is a cross-community bridge._
- **What connects `viewState`, `ViewerClosedMsg`, `PipelineClosedMsg` to the rest of the system?**
  _13 weakly-connected nodes found - possible documentation gaps or missing edges._