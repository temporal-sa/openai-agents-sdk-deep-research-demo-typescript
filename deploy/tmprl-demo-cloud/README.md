# Deploy to tmprl-demo.cloud

[`openai-deep-research-ts.yaml`](openai-deep-research-ts.yaml) is the complete
`DemoProject` resource for the private
[`temporal-sa/tmprl-demo-cloud-registry`](https://github.com/temporal-sa/tmprl-demo-cloud-registry).
The registry operator builds this repository, provisions an isolated Temporal
Cloud namespace, injects runtime credentials, deploys one combined API/worker
pod, checks readiness, and then promotes the HTTPS route.

The expected public URL is
<https://openai-deep-research-ts.tmprl-demo.cloud>.

## Prerequisites

- This repository exists as
  `temporal-sa/openai-agents-sdk-deep-research-demo-typescript`, with its default
  branch named `main`.
- CI passes on `main`, including the root `Dockerfile` build.
- You can open a pull request against the private cloud-registry repository.
- A platform operator can create the project-scoped OpenAI secret in AWS
  Secrets Manager in `us-west-1`.

The registry already owns the shared GitHub source credential, build service,
Kubernetes cluster, ingress, certificate, and Temporal Cloud bootstrap
credential. Do not add any of those values to this repository.

## 1. Create the OpenAI secret

Create an AWS Secrets Manager JSON secret with this exact name:

```text
tmprl-dem-cld/openai-deep-research-ts/openai-credentials
```

Its value must have this shape:

```json
{
  "OPENAI_API_KEY": "sk-..."
}
```

Use the AWS console or an approved secret-management workflow. Avoid putting a
literal API key on a command line, where it may be retained in shell history.
The operator verifies that `OPENAI_API_KEY` exists and exposes only that value
to the app through the manifest's `valueFrom.inputRef`.

An operator can confirm the secret without retrieving its value:

```bash
aws secretsmanager describe-secret \
  --region us-west-1 \
  --secret-id tmprl-dem-cld/openai-deep-research-ts/openai-credentials
```

## 2. Add the project to the registry

From a clean checkout of `temporal-sa/tmprl-demo-cloud-registry`, copy this
repository's manifest into the registry's auto-discovered project directory:

```bash
cp /path/to/openai-agents-sdk-deep-research-demo-typescript/deploy/tmprl-demo-cloud/openai-deep-research-ts.yaml \
  projects/demo/openai-deep-research-ts.yaml
```

That one `projects/demo/` file is the only deployment asset committed to the
registry. Do not add a project `kustomization.yaml`, Helm chart, Kubernetes
Deployment, image tag, Temporal credential, namespace, or certificate.

Validate the complete registry before opening the pull request:

```bash
python3 -m pip install -r requirements-dev.txt
python3 scripts/validate_projects.py
```

If the local Python environment is intentionally isolated, the registry also
documents this equivalent command:

```bash
uv run --isolated --with jsonschema --with pyyaml python scripts/validate_projects.py
```

Commit `projects/demo/openai-deep-research-ts.yaml`, open a registry pull
request, and merge it after review. Flux applies the custom resource; the
registry operator then performs the build and rollout. No manual `kubectl apply`
step is part of normal onboarding.

## 3. Verify the rollout

The ordinary phase progression is:

```text
Reconciling -> WaitingForExternalResources -> WaitingForImages
-> CandidateApplied -> SmokeCheckPending -> Promoted
```

The manifest gates promotion on `GET /api/ready` returning `200`. Unlike the
liveness endpoint, readiness performs a deadline-bounded Temporal connection
check, so an app that cannot reach its provisioned namespace is not promoted.

Platform operators can inspect the rollout with:

```bash
kubectl get demoproject openai-deep-research-ts -o yaml
kubectl -n tmprl-dem-cld-openai-deep-research-ts \
  get deploy,svc,ingressroute,certificate,externalsecret,pods
kubectl -n tmprl-dem-cld-registry-operator \
  logs deploy/registry-operator-watch -f
```

After the phase is `Promoted`, verify the public health and readiness paths and
then run a small research query through the UI. A full query calls paid OpenAI
APIs, including web search and potentially image generation.

## Runtime contract

- `worker: true` tells the platform to inject `TEMPORAL_ADDRESS`,
  `TEMPORAL_NAMESPACE`, `TEMPORAL_API_KEY`, and TLS configuration. The combined
  process serves HTTP and polls `research-queue` with those credentials.
- `replicas: 1` keeps the API and worker on the same writable filesystem. The
  app writes generated images and PDFs below `/app/artifacts`.
- `AUTH_MODE=temporal-ingress` trusts `X-Temporal-Auth-Email`, which the managed
  authenticated ingress strips and injects. Never expose this container
  directly to untrusted traffic in that mode.
- `temporalAuthRequired: true` protects the public demo at the ingress. The app
  still leaves `/api/health` and `/api/ready` public for platform probes.
- `FRONTEND_ORIGINS` permits only the deployed HTTPS origin.
- `BYPASS_TRIAGE_AGENT=Y` deliberately makes the clarification and Activity
  retry sequence visible during demonstrations.

### Artifact persistence and retention

The application contract supports a writable artifact directory through
`ARTIFACT_ROOT`. A production multi-replica deployment should mount the same
persistent shared volume at that path for every API and worker replica, and
should apply an external retention/cleanup policy to generated images and PDFs.

The current thin `DemoProject` schema has no persistent-volume field. This
manifest therefore uses one replica with ephemeral container storage; artifacts
can disappear whenever the pod is replaced. Temporal preserves workflow state
and can replay the orchestration, but it does not preserve files written by an
Activity. Treat the hosted configuration as a demo until the platform provides
shared durable storage (or the app moves artifacts to object storage).

## Updates, rollback, and teardown

Changes pushed to this repository's `main` branch cause the registry to resolve
a new source revision, build an immutable candidate image, run readiness and
the smoke check, and promote only on success. If a release is bad, revert the
source commit on `main`; the registry will build and promote the reverted
revision. A failed candidate leaves the currently promoted route in place.

Removing `projects/demo/openai-deep-research-ts.yaml` is destructive. Flux
prunes the `DemoProject`, and the operator's finalizer deletes the Kubernetes
namespace, ECR resources, and the managed Temporal Cloud namespace, including
its workflow history. Use registry teardown only when permanent deletion is
intended. The project-scoped OpenAI secret is operator-managed separately and
should be removed according to the team's credential-retention procedure.
