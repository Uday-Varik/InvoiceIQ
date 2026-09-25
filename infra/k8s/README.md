# Kubernetes (Written-unverified, reference only)

ADR-0008 chose serverless hosting. If the project ever moves to Kubernetes,
the constraints to preserve are: ai-service in its own namespace with a
NetworkPolicy that denies egress to Postgres, and core-api as the only workload
with a database Secret.
