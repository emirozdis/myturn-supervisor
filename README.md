# MyTurn Vast Supervisor

Independent private service, linked into the [MyTurn parent](https://github.com/emirozdis/myturn) as `supervisor/`. It coordinates [myturn-backend](https://github.com/emirozdis/myturn-backend) and the [FFmpeg worker](https://github.com/emirozdis/ffmpeg-api).

Always-on control plane for ordinary Vast.ai GPU instances. Vercel registers a
durable mission after an R2 upload is finalized; this service immediately wakes,
reuses healthy workers, provisions policy-compliant offers, dispatches work, and
stops or destroys idle capacity.

## Responsibilities

- Authenticated, idempotent `POST /v1/missions`
- Shared-PostgreSQL mission and instance state
- Vast offer search, auditable full-machine classification, and cheapest-qualified selection
- Worker startup/health monitoring and bounded per-worker capacity
- Automatic retries, unhealthy-instance replacement, and mission requeueing
- Configurable idle stop/destroy behavior
- Structured Pino logs plus durable events for the MyTurn admin page
- Authenticated, batched ingestion of structured worker logs that survives
  instance destruction, with idempotent event IDs and configurable retention

The service must run as a single Coolify deployment. A PostgreSQL advisory lock
also prevents overlapping reconciliation if two replicas temporarily coexist.

## Local development

Use Node.js 22 or later. Install dependencies with `npm ci`, copy `.env.example` to `.env`, and configure a development database and the required service credentials. The backend owns database migrations; apply them to the development database before starting this service.

The service reads the process environment directly; it does not load `.env` automatically. For local use:

```sh
npm ci
cp .env.example .env
# Fill in .env, then:
node --env-file=.env --import tsx src/index.ts
```

The default port is 3010. `npm test` builds the service and runs the test suite. To run a compiled build locally, use `npm run build` followed by `node --env-file=.env dist/index.js`. Hosting platforms should inject environment variables and use `npm start` or the supplied Dockerfile.

This service can create, stop, and destroy Vast instances when it reconciles work. Use a development database and appropriately scoped credentials for local operation.

## Deployment steps

1. Apply the MyTurn Prisma migration.
2. Configure the `default` supervisor policy in `/admin/transcoder`, including
   the immutable Vast template hash used to launch `transcoder/Dockerfile.gpu`.
3. Deploy this folder to Coolify with the variables in `.env.example`.
4. Configure matching `SUPERVISOR_MISSION_SECRET` and `TRANSCODER_SUPERVISOR_URL`
   in Vercel.
5. Keep worker R2/webhook secrets inside the private Vast template. Never store
   them in the admin-configurable policy row.

Set the same independent `WORKER_LOG_INGEST_SECRET` in the supervisor and the
`myturn-transcoder` Vast template. The worker template must also set
`TRANSCODER_LOG_SINK_URL=https://<supervisor-host>/v1/worker-logs`. Use `info`
for `REMOTE_LOG_LEVEL` in normal production operation; temporarily use `debug`
when FFmpeg-level diagnostics are required. Pending batches are spooled under
the worker `STATE_DIR`, retried with backoff, and included in the safe-stop
barrier.
Set worker-log retention to `0` in the admin policy to retain logs indefinitely;
otherwise the supervisor removes records older than the configured number of
days once per hour.

The template must publish container port 3000 (for example `-p 3000:3000`) and
must use `runtype=args` so the image entrypoint starts the API. Route worker
traffic over a private network or TLS tunnel in production; ordinary public
port mappings are not encrypted.

When full-machine mode is enabled, the classifier requires effective CPU to
match total CPU, allocated RAM to match total RAM, GPU fraction to be one, and
Vast's VM flag to be false. Every decision is stored with the instance record.
After applying all configured eligibility requirements, the supervisor selects
the lowest hourly price. Exact price ties prefer higher reliability, then
DLPerf/$, then the lower Vast offer ID for deterministic ordering. The GPU
allowlist is the video-capability qualification; DLPerf is not treated as a
proxy for HLS transcoding performance.
