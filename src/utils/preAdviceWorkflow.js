export const WORKFLOW_STAGES = [
  'BOOKING_SUBMITTED',
  'BOOKING_APPROVED',
  'READY_FOR_GATE_IN',
  'GATE_IN_PAYMENT_SUBMITTED',
  'GATE_IN',
  'INVENTORY',
  'STORAGE',
  'GATE_OUT_REQUESTED',
  'GATE_OUT_PAYMENT_PENDING',
  'GATE_OUT_PAYMENT_SUBMITTED',
  'GATE_OUT_APPROVED',
  'READY_FOR_RELEASE',
  'CONTAINER_RELEASED',
];

const STATUS_STAGE_MAP = {
  SUBMITTED: ['BOOKING_SUBMITTED'],
  SCHEDULED: ['BOOKING_APPROVED'],
  READY_FOR_GATE_IN: ['READY_FOR_GATE_IN'],
  GATED_IN: ['GATE_IN', 'INVENTORY'],
  COMPLETED: ['CONTAINER_RELEASED'],
};

export function advanceWorkflow(item, stages, options = {}) {
  const list = Array.isArray(stages) ? stages : [stages];
  const now = options.changedAt || new Date();

  if (!Array.isArray(item.workflowHistory)) item.workflowHistory = [];

  for (const stage of list) {
    if (!WORKFLOW_STAGES.includes(stage)) continue;
    const alreadyRecorded = item.workflowHistory.some((entry) => entry.stage === stage);
    if (!alreadyRecorded) {
      item.workflowHistory.push({
        stage,
        changedAt: now,
        note: options.note || '',
      });
    }
    item.workflowStage = stage;
  }

  return item;
}

export function syncWorkflowFromStatus(item, status, options = {}) {
  const stages = STATUS_STAGE_MAP[status] || [];
  if (stages.length) advanceWorkflow(item, stages, options);
  return item;
}

export function ensureWorkflow(item) {
  if (item.workflowHistory?.length) return item;

  const statusHistory = Array.isArray(item.statusHistory) ? item.statusHistory : [];
  for (const history of statusHistory) {
    syncWorkflowFromStatus(item, history.status, {
      changedAt: history.changedAt || item.createdAt || new Date(),
      note: history.note || '',
    });
  }

  if (!item.workflowHistory?.length) {
    syncWorkflowFromStatus(item, item.status || 'SUBMITTED', {
      changedAt: item.createdAt || new Date(),
    });
  }

  if (item.storage?.status === 'STORED') {
    advanceWorkflow(item, 'STORAGE', { changedAt: item.storage.storedAt || item.updatedAt || new Date() });
  } else if (item.storage?.status === 'RELEASE_PENDING') {
    advanceWorkflow(item, 'GATE_OUT_REQUESTED', { changedAt: item.updatedAt || new Date() });
  } else if (item.storage?.status === 'RELEASED') {
    advanceWorkflow(item, 'CONTAINER_RELEASED', { changedAt: item.updatedAt || new Date() });
  }

  return item;
}
