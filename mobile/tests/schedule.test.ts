// 定时任务：下次执行时间、周期说明、参数整理、到点检查，以及 Agent 的 schedule_* 工具。

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { FetchLike } from '../src/agent/llm';
import { createPhoneTools, type ScheduleApi } from '../src/agent/phoneTools';
import {
  checkDue,
  computeNextRun,
  describeSchedule,
  GRACE_MS,
  parseLocalDateTime,
  parseScheduleArgs,
  type ScheduledTask,
  type ScheduleInput,
} from '../src/agent/schedule';

/** 本地时间 */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const noFetch: FetchLike = async () => ({ ok: false, status: 500, text: async () => '', body: null });

describe('下次执行时间', () => {
  // 2026-11-20 是周五
  const now = at(2026, 11, 20, 9, 0);

  it('每天：今天的时间已过就排到明天', () => {
    assert.equal(computeNextRun({ kind: 'daily', time: '08:30' }, now), at(2026, 11, 21, 8, 30));
    assert.equal(computeNextRun({ kind: 'daily', time: '21:00' }, now), at(2026, 11, 20, 21, 0));
  });

  it('每周：找最近的一个指定星期几', () => {
    assert.equal(computeNextRun({ kind: 'weekly', time: '09:00', weekdays: [1, 3] }, now), at(2026, 11, 23, 9, 0)); // 下周一
    assert.equal(computeNextRun({ kind: 'weekly', time: '10:00', weekdays: [5] }, now), at(2026, 11, 20, 10, 0)); // 今天周五
    assert.equal(computeNextRun({ kind: 'weekly', time: '08:00', weekdays: [5] }, now), at(2026, 11, 27, 8, 0)); // 下周五
  });

  it('间隔：从上次执行（或创建时间）起按间隔推算', () => {
    assert.equal(computeNextRun({ kind: 'interval', intervalMin: 60, createdAt: at(2026, 11, 20, 7, 10) }, now), at(2026, 11, 20, 9, 10));
    assert.equal(computeNextRun({ kind: 'interval', intervalMin: 5, createdAt: now }, now), now + 15 * 60_000); // 不少于 15 分钟
  });

  it('一次：时间未到返回该时间，已过返回 null', () => {
    assert.equal(computeNextRun({ kind: 'once', at: at(2026, 11, 21, 8) }, now), at(2026, 11, 21, 8));
    assert.equal(computeNextRun({ kind: 'once', at: at(2026, 11, 19, 8) }, now), null);
  });
});

describe('周期说明和参数', () => {
  it('说明文字', () => {
    assert.equal(describeSchedule({ kind: 'daily', time: '08:30' }), '每天 08:30');
    assert.equal(describeSchedule({ kind: 'weekly', time: '09:00', weekdays: [5, 1, 3] }), '每周一、三、五 09:00');
    assert.equal(describeSchedule({ kind: 'weekly', time: '09:00', weekdays: [1, 2, 3, 4, 5] }), '工作日 09:00');
    assert.equal(describeSchedule({ kind: 'interval', intervalMin: 120 }), '每 2 小时');
    assert.equal(describeSchedule({ kind: 'interval', intervalMin: 30 }), '每 30 分钟');
  });

  it('整理参数：补零、去重、校验', () => {
    const now = at(2026, 11, 20, 9, 0);
    assert.deepEqual(parseScheduleArgs({ name: '体检', prompt: '做体检', kind: 'weekly', time: '9:05', weekdays: [5, 1, 1, 9] }, now), {
      name: '体检',
      prompt: '做体检',
      kind: 'weekly',
      time: '09:05',
      weekdays: [1, 5],
    });
    assert.deepEqual(parseScheduleArgs({ name: 'a', prompt: 'b', kind: 'once', datetime: '2026-11-21 08:00' }, now), {
      name: 'a',
      prompt: 'b',
      kind: 'once',
      at: at(2026, 11, 21, 8),
    });
    assert.equal(typeof parseScheduleArgs({ name: 'a', prompt: 'b', kind: 'once', datetime: '2026-11-19 08:00' }, now), 'string');
    assert.equal(typeof parseScheduleArgs({ name: 'a', prompt: 'b', kind: 'interval', interval_minutes: 5 }, now), 'string');
    assert.equal(typeof parseScheduleArgs({ name: 'a', prompt: 'b', kind: 'daily', time: '25:00' }, now), 'string');
    assert.equal(typeof parseScheduleArgs({ name: '', prompt: 'b', kind: 'daily', time: '08:00' }, now), 'string');
    assert.equal(parseLocalDateTime('2026-02-30 08:00'), null);
  });

  it('到点检查：30 分钟内补执行，超过记为错过；停用、执行中的跳过', () => {
    const now = at(2026, 11, 20, 9, 0);
    const base = { name: 'x', prompt: 'p', kind: 'daily' as const, time: '08:00', enabled: true, createdAt: 0, createdBy: 'user' as const };
    const tasks: ScheduledTask[] = [
      { ...base, id: 'due', nextRunAt: now - 10 * 60_000 },
      { ...base, id: 'missed', nextRunAt: now - GRACE_MS - 1 },
      { ...base, id: 'future', nextRunAt: now + 1 },
      { ...base, id: 'off', enabled: false, nextRunAt: now - 1 },
      { ...base, id: 'busy', nextRunAt: now - 1, lastStatus: 'running' },
    ];
    const r = checkDue(tasks, now);
    assert.deepEqual(
      r.due.map((t) => t.id),
      ['due'],
    );
    assert.deepEqual(
      r.missed.map((t) => t.id),
      ['missed'],
    );
  });
});

describe('schedule_* 工具', () => {
  function fakeApi() {
    const tasks: ScheduledTask[] = [];
    const api: ScheduleApi = {
      list: () => tasks,
      create: (input: ScheduleInput) => {
        const t: ScheduledTask = {
          ...input,
          id: `t${tasks.length + 1}`,
          enabled: true,
          createdAt: 0,
          createdBy: 'agent',
          nextRunAt: Date.now() + 3600_000,
        };
        tasks.push(t);
        return t;
      },
      update: (id, patch) => {
        const t = tasks.find((x) => x.id === id);
        if (t) Object.assign(t, patch);
        return t ?? null;
      },
      remove: (id) => {
        const i = tasks.findIndex((x) => x.id === id);
        if (i >= 0) tasks.splice(i, 1);
        return i >= 0;
      },
    };
    return { api, tasks };
  }

  it('创建、列出、停用、删除', async () => {
    const { api, tasks } = fakeApi();
    const t = createPhoneTools({ fetch: noFetch, downloadToPc: null, schedules: api });
    const text = (r: { content: { type: string; text?: string }[] }) => r.content[0].text ?? '';
    const c = await t.call('schedule_create', { name: '每日体检', prompt: '给电脑体检', kind: 'daily', time: '8:00' });
    assert.equal(c.isError, false);
    assert.match(text(c), /每日体检 \| 每天 08:00/);
    assert.equal(tasks[0].createdBy, 'agent');
    assert.match(text(await t.call('schedule_list', {})), /共 1 个定时任务/);
    await t.call('schedule_update', { id: 't1', enabled: false });
    assert.equal(tasks[0].enabled, false);
    assert.equal((await t.call('schedule_delete', { id: 't1' })).isError, false);
    assert.equal((await t.call('schedule_delete', { id: 't1' })).isError, true);
    assert.equal((await t.call('schedule_create', { name: 'x', prompt: 'y', kind: 'hourly' })).isError, true);
  });

  it('指定在哪几台电脑上执行', async () => {
    const { api, tasks } = fakeApi();
    const pcs = [
      { id: 'pc-a', name: '办公室' },
      { id: 'pc-b', name: '家里' },
    ];
    api.pcNames = () => pcs.map((p) => p.name);
    api.resolvePcs = (names) => {
      const ids = names.map((n) => pcs.find((p) => p.name === n)?.id);
      return ids.every(Boolean) ? (ids as string[]) : `找不到电脑：${names.join('、')}`;
    };
    api.pcLabel = (id) => pcs.find((p) => p.id === id)?.name ?? '?';
    const t = createPhoneTools({ fetch: noFetch, downloadToPc: null, schedules: api });
    const text = (r: { content: { type: string; text?: string }[] }) => r.content[0].text ?? '';

    // 记住了电脑时，schedule_create / schedule_update 多一个 pcs 参数，候选就是电脑名
    const create = t.list().find((x) => x.name === 'schedule_create')!;
    const props = (create.inputSchema as { properties: Record<string, { items?: { enum?: string[] } }> }).properties;
    assert.deepEqual(props.pcs.items?.enum, ['办公室', '家里']);

    const c = await t.call('schedule_create', { name: '两台体检', prompt: '体检', kind: 'daily', time: '09:00', pcs: ['办公室', '家里'] });
    assert.equal(c.isError, false);
    assert.deepEqual(tasks[0].pcs, ['pc-a', 'pc-b']);
    assert.match(text(c), /电脑：办公室、家里/);

    // 找不到的电脑报错，不创建
    const bad = await t.call('schedule_create', { name: 'x', prompt: 'y', kind: 'daily', time: '09:00', pcs: ['公司'] });
    assert.equal(bad.isError, true);
    assert.equal(tasks.length, 1);

    // 改成只在一台上执行；传空数组改回当前电脑
    await t.call('schedule_update', { id: 't1', pcs: ['家里'] });
    assert.deepEqual(tasks[0].pcs, ['pc-b']);
    await t.call('schedule_update', { id: 't1', pcs: [] });
    assert.deepEqual(tasks[0].pcs, []);

    // 没记住电脑时不加 pcs 参数
    const plain = createPhoneTools({ fetch: noFetch, downloadToPc: null, schedules: fakeApi().api });
    const p2 = plain.list().find((x) => x.name === 'schedule_create')!;
    assert.equal('pcs' in (p2.inputSchema as { properties: object }).properties, false);
  });
});
