// The controller owns admission; applications only carry validated intent.
export function schedulingOptions(headers) {
  const result = {};
  for (const [header, field] of Object.entries({ 'x-vscheduler-priority': 'priority', 'x-vscheduler-preemptible': 'preemptible', 'x-vscheduler-allow-preemption': 'allow_preemption', 'x-vscheduler-force-admission': 'force_admission' })) {
    if (headers[header] === undefined) continue;
    const value = headers[header];
    if (field === 'priority' ? !['background', 'interactive', 'high'].includes(value) : !['true', 'false'].includes(value)) {
      throw Object.assign(new Error('Invalid scheduling option'), { status: 422 });
    }
    result[field] = field === 'priority' ? value : value === 'true';
  }
  return result;
}

// Copy only validated scheduling intent across the root-to-worker proxy.
export function forwardedSchedulingHeaders(headers) {
  const options = schedulingOptions(headers);
  const result = {};
  for (const [field, header] of Object.entries({ priority: 'x-vscheduler-priority', preemptible: 'x-vscheduler-preemptible', allow_preemption: 'x-vscheduler-allow-preemption', force_admission: 'x-vscheduler-force-admission' })) {
    if (options[field] !== undefined) result[header] = String(options[field]);
  }
  if (headers['x-vscheduler-queue-wait-seconds'] !== undefined) result['x-vscheduler-queue-wait-seconds'] = String(queueWaitSeconds(headers));
  return result;
}

export function queueWaitSeconds(headers) {
  const value = headers['x-vscheduler-queue-wait-seconds'] ?? '30';
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value) || Number(value) > 300) throw Object.assign(new Error('Queue wait must be an integer from 0 to 300 seconds'), { status: 422 });
  return Number(value);
}
