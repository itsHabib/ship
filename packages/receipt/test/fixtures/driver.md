---
driver_version: 1
generated_at: 2026-05-18T00:00:00Z
generated_by: work-driver-prep
source:
  project: dossier
  phase: hygiene-followups
repo: dossier
branch_prefix: tower/hygiene-

batches:
  - id: 1
    label: ready now
    depends_on: []
    status: done
    completed_at: 2026-05-18T02:25:30Z
    streams:
      - task_id: tsk_A
        task_slug: actor-on-update-verbs
        spec_path: docs/features/hygiene-followups/actor-on-update-verbs.md
        branch_name: tower/hygiene-actor-on-update-verbs
        touches: [src/server.rs]
        status: done
        pr_number: 24
        merge_commit: e966e87ddf963f19b0e7e13e5424cd9162893532
        merged_at: 2026-05-18T02:22:26Z
        cycles: 2
        runtime: local
      - task_id: tsk_B
        task_slug: failed-stream
        spec_path: docs/features/hygiene-followups/failed-stream.md
        branch_name: tower/hygiene-failed-stream
        status: failed
        cycles: 1
        runtime: cloud

  - id: 2
    label: after batch 1
    depends_on: [1]
    status: done
    streams:
      - task_id: tsk_C
        task_slug: still-pending
        spec_path: docs/features/hygiene-followups/still-pending.md
        branch_name: tower/hygiene-still-pending
        status: pending
      - task_id: tsk_D
        task_slug: capped-stream
        spec_path: docs/features/hygiene-followups/capped-stream.md
        branch_name: tower/hygiene-capped-stream
        status: done
        pr_number: 30
        merge_commit: c17ba6f82e4ce755db47466ae46d7a05c6713050
        merged_at: 2026-05-18T03:13:45Z
        cycles: 4
        runtime: cloud
---

# hygiene-followups driver manifest (fixture)

Body prose after the frontmatter is ignored by the parser.
