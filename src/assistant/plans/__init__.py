"""«Составь план» (step 8, VISION §1; contract: docs/api/plans.md).

Public surface:
- `build`: the model's structured plan (`PlanReply`, `LLMTask.PLAN`, prompt `plan.v1`) checked
  and turned into the stored plan by code (`build.build`), its readable text, the chat card.
- `service`: the plan's record (`items.kind = 'plan'`, 0033), «Сделать делами» (`make_tasks`: one
  action per step in one group), the plan as it is now (`plan_dict`).
The chat side (the `make_plan` tool, «сделай делами» by phrase) is `assistant.chat.plan_line`.
"""

from assistant.plans import build, service
from assistant.plans.build import PlanReply, SourceRef
from assistant.plans.service import Converted, PlanError, make_tasks, plan_dict, plan_of

__all__ = ["Converted", "PlanError", "PlanReply", "SourceRef", "build", "make_tasks",
           "plan_dict", "plan_of", "service"]  # fmt: skip
