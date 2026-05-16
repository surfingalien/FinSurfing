# FinSurfing Autonomous Agents

This directory contains autonomous AI agent personalities designed for FinSurfing's trading platform. Each agent is specialized for a specific domain and can operate autonomously or in coordination with other agents.

## Available Agents

### 1. **FinSurf Payment Processor Agent**
**File:** `finsurf-payment-processor.md`

Autonomous payment operations specialist for FinSurfing's trading platform. Handles:
- Trade settlement and execution
- Portfolio rebalancing payments
- Subscription billing across crypto, fiat, and stablecoin rails
- Regulatory audit trail maintenance

**Key Features:**
- Idempotent settlement verification (no duplicate payments)
- Multi-rail payment optimization
- Audit trail for regulatory compliance
- Automatic failure recovery with escalation

**Use Case:** Trigger after every trade execution for settlement processing.

---

### 2. **FinSurf Identity & Trust Architect**
**File:** `finsurf-identity-architect.md`

Designs identity, authentication, and trust systems for autonomous trading agents. Ensures:
- Cryptographic proof of agent identity
- Trading authorization verification
- Trust scoring based on verified execution
- Tamper-evident audit trails for regulatory compliance

**Key Features:**
- Zero-trust architecture for trading agents
- Multi-hop delegation with scope restrictions
- Evidence-based trust scoring
- Post-quantum ready design

**Use Case:** Use to design agent authorization systems and regulatory compliance infrastructure.

---

### 3. **FinSurf Development Orchestrator**
**File:** `finsurf-development-orchestrator.md`

Autonomous pipeline manager for FinSurfing's development workflow. Orchestrates:
- Feature specification to technical architecture
- Development implementation with continuous QA validation
- Production integration and testing
- Complete feature delivery through quality gates

**Key Features:**
- Automatic task-by-task quality validation
- Retry logic with escalation (max 3 attempts)
- Clear progress reporting and status updates
- Production-ready feature delivery

**Use Case:** Launch with `finsurf-development-orchestrator` command for autonomous feature delivery.

```bash
Please spawn a finsurf-development-orchestrator to execute complete development pipeline 
for features/[feature-name]-spec.md. Run autonomous workflow: project-manager-senior → 
ArchitectUX → [Developer ↔ EvidenceQA task-by-task loop] → testing-reality-checker.
```

---

### 4. **FinSurf Automation Governance Architect**
**File:** `finsurf-automation-governance.md`

Governance-first architect for trading automations (n8n-based). Evaluates:
- What should be automated vs. manual control
- Trading automation ROI and capital risk
- Circuit breaker and safety requirements
- Regulatory compliance of automations

**Key Features:**
- Mandatory decision framework for automation approval
- Circuit breaker requirements for all trading automations
- n8n workflow standards and naming conventions
- Compliance-aware automation design

**Use Case:** Use to evaluate whether a process should be automated and how to implement it safely.

```bash
Use the FinSurf Automation Governance Architect to evaluate this trading automation request.
Apply mandatory scoring for time savings, capital risk, dependency stability, and compliance impact.
Return a verdict, rationale, circuit breaker requirements, architecture recommendation, 
and rollout preconditions.
```

---

## Agent Coordination Patterns

### Pattern 1: Complete Feature Delivery
```
DevelopmentOrchestrator
  ↓
ProjectManager (create task list)
  ↓
ArchitectUX (build technical foundation)
  ↓
Developer + EvidenceQA (iterative dev-QA loop)
  ↓
TestingRealityChecker (final validation)
  ↓
Production Deployment
```

### Pattern 2: Trade Execution & Settlement
```
TradingEngine
  ↓
IdentityArchitect (verify authorization)
  ↓
PaymentProcessor (execute settlement)
  ↓
ComplianceReporter (audit trail)
```

### Pattern 3: Automation Safety
```
AutomationRequest
  ↓
AutomationGovernance (evaluate risk)
  ↓
IF approved:
  - n8n workflow design
  - Circuit breaker implementation
  - Testing and validation
  - Production deployment with monitoring
```

---

## Agent Capabilities by Domain

### Trading Operations
- **Payment Processor** — Settlement execution and verification
- **Identity Architect** — Agent authorization and trust
- **Automation Governance** — Safe automation of trading processes

### Product Development
- **Development Orchestrator** — Feature delivery pipeline
- **Architecture Designer** — Technical foundations (ArchitectUX)
- **Quality Assurance** — Evidence-based testing (EvidenceQA)

### Compliance & Auditing
- **Identity Architect** — Audit trail creation and verification
- **Payment Processor** — Settlement audit reports
- **Automation Governance** — Compliance review of automations

---

## Integration Guidelines

### Adding a New Agent
1. Create a new `.md` file in the `agents/` directory
2. Follow the personality template structure
3. Include specific FinSurfing trading context
4. Add to this README under "Available Agents"
5. Document coordination patterns with existing agents

### Using Agents Together
1. **Always provide context** — agents need to understand what other agents have done
2. **Pass state between agents** — don't require re-reading files
3. **Use explicit handoffs** — name the next agent and what it should do
4. **Monitor for conflicts** — ensure agents aren't making contradictory decisions

### Monitoring Agent Performance
- Track agent success rates by type
- Monitor for failed handoffs between agents
- Review audit trails for compliance
- Identify bottlenecks in agent workflows

---

## Safety & Risk Management

### Circuit Breakers (All Agents)
- Automation Governance requires circuit breakers on all trading automations
- Payment Processor enforces settlement limits
- Identity Architect implements fail-closed authorization

### Audit Trails (All Agents)
- Every consequential action must be logged
- Logs must be tamper-evident (append-only)
- Compliance must be able to independently verify all records

### Human Approval Gates
- Trading automations must pass governance review
- Large settlements require human authorization
- Production deployments require QA sign-off

---

## Performance Targets

| Agent | Metric | Target |
|-------|--------|--------|
| Payment Processor | Settlement latency (instant rails) | < 60 seconds |
| Identity Architect | Pre-trade verification latency | < 50ms p99 |
| Development Orchestrator | Feature delivery cycle | Predictable, tracked |
| Automation Governance | Approval decision turnaround | < 24 hours |

---

## Emergency Procedures

### Kill Switch (All Agents)
If any agent is misbehaving:
1. Stop spawning new instances
2. Cancel in-flight operations
3. Review last 10 logs for root cause
4. Report incident to operations

### Rollback (Payment Processor)
If settlements are failing:
1. Switch to manual settlement mode
2. Verify all pending settlements
3. Investigate root cause
4. Re-enable with close monitoring

### Circuit Breaker Triggers
- If daily trading volume exceeds limits → block new trades
- If settlement success rate drops below 95% → escalate to manual
- If agent trust score falls below 0.5 → require re-authorization

---

## References

- [FinSurfing Trading Platform](../README.md)
- [Trading System Architecture](../docs/)
- [Compliance Requirements](../compliance/)
- [Deployment Procedures](../deployment/)

---

**Last Updated:** May 16, 2026  
**Maintained By:** FinSurfing Platform Team
