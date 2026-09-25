# Deployment Process - Iris

This project follows a 3-stage deployment process to ensure code quality and stability:

## 🎯 3-Stage Deployment Process

### Stage 1: Local Development
- **Environment**: Local development machine
- **Purpose**: Development and initial testing
- **Location**: a local clone of this repository
- **Usage**: Primary development environment where features are built and initially tested

### Stage 2: Staging Server ⚠️ **HIGH PRIORITY SETUP**
- **Environment**: the staging server (host details are in the operator's runbook)
- **Purpose**: Stable "sprint demo" environment
- **Usage**: 
  - Integration testing
  - Sprint demonstrations
  - QA testing
  - Pre-production validation
- **Status**: 🚧 **NEEDS SETUP** - This should be one of the first tasks when beginning development work

### Stage 3: Production Deployment
- **Environment**: Live VPS with production configurations
- **Purpose**: End-user production environment
- **Features**:
  - Full production configurations
  - Live user access
  - Production monitoring and logging

## Next Steps
1. ⚠️ **PRIORITY**: Configure the staging server environment
2. Set up deployment pipelines between stages
3. Establish testing protocols for each stage
4. Configure monitoring and logging for production

---

**Last Updated**: 2025-10-18
**Environment**: 3-Stage Deployment Process