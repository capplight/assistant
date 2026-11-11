"""Account data: «Скачать мои данные» and account deletion (week 16; spec 4.9, 7.2; F-26, F-27;
contract docs/api/account.md). Worker: `python -m assistant.account` (jobs `account:export`,
`account:purge`, and the hourly sweep of expired archives).

Public surface: `request_deletion`, `pending_deletion`, `issue_restore`, `cancel_deletion`,
`new_restore_token`, `run_purge` (service); `JOB_EXPORT`, `build_export`, `expire_exports`,
`export_key` (export); `run_one`, `worker_loop` (worker module).
"""

from assistant.account.export import JOB_EXPORT, build_export, expire_exports, export_key
from assistant.account.service import (
    JOB_PURGE,
    DeletionDone,
    RestoreInvalid,
    cancel_deletion,
    issue_restore,
    new_restore_token,
    pending_deletion,
    purge_job_key,
    request_deletion,
    run_purge,
)

__all__ = ["JOB_EXPORT", "JOB_PURGE", "DeletionDone", "RestoreInvalid", "build_export",
           "cancel_deletion", "expire_exports", "export_key", "issue_restore",
           "new_restore_token", "pending_deletion", "purge_job_key", "request_deletion",
           "run_purge"]  # fmt: skip
