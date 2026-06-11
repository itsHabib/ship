---
driver_version: 1
generated_at: 2026-06-10T12:00:00Z
generated_by: work-driver-prep
source:
  project: ship
  phase: driver-extraction
repo: ship
repo_url: https://github.com/itsHabib/ship
branch_prefix: driver-
default_runtime: local

batches:
  - id: 1
    label: parallel mixed runtimes
    depends_on: []
    status: running
    completed_at: 2026-06-10T13:00:00Z
    streams:
      - task_id: tsk_01SYNTH000000000000000001
        task_slug: local-stream
        spec_path: docs/features/driver-extraction/phases/local-stream.md
        branch_name: driver-local-stream
        runtime: local
        touches: [packages/driver/src/manifest.ts]
        status: done
        pr_number: 100
        merge_commit: abc123def456
        merged_at: 2026-06-10T12:30:00Z
        cycles: 1
      - task_id: tsk_01SYNTH000000000000000002
        task_slug: cloud-stream
        spec_path: docs/features/driver-extraction/phases/cloud-stream.md
        runtime: cloud
        touches: [packages/driver/README.md]
        status: in_progress
      - task_id: tsk_01SYNTH000000000000000003
        task_slug: rooms-stream
        spec_path: docs/features/driver-extraction/phases/rooms-stream.md
        branch_name: driver-rooms-stream
        runtime: rooms
        status: failed
        cycles: 3

  - id: 2
    label: after batch 1
    depends_on: [1]
    status: pending
    streams:
      - spec_path: docs/features/driver-extraction/phases/follow-up.md
        status: todo

  - id: 3
    label: skipped stream batch
    depends_on: [2]
    status: done
    streams:
      - task_slug: skipped-task
        spec_path: docs/features/driver-extraction/phases/skipped.md
        status: skipped

conflict_notes:
  - kind: file_overlap
    file: packages/driver/src/manifest.ts
    tasks: [local-stream, cloud-stream]
  - "advisory prose string entry"

skipped_during_resolution:
  - reason: "example skip during prep"
    workaround: "manual batch assignment"

runtime_notes:
  - "batch 1 uses mixed runtimes for fixture coverage"
  - kind: policy
    note: "rooms runtime is experimental"

ping_gates:
  - "review cycle 3 cap"
  - kind: loc_stretch
    threshold: 1000
---

# Synthetic full driver manifest

Fixture covering every schema field for `@ship/driver` golden tests.
