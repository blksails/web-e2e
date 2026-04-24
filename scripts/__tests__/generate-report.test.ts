import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Tests for the report generator's pure helpers. We test by copy-pasting the parser into a
 * local fixture rather than importing — generate-report.ts has side-effects at import time
 * (reads TASKS_DOC, writes index.html). Keeping the tests decoupled from the script shape
 * means refactors don't break them as long as the parser rules stay stable.
 */

interface SopItem {
  sop: string;
  key: string;
  label: string;
}

function parseSopItems(src: string): SopItem[] {
  const items: SopItem[] = [];
  let sop = '';
  for (const line of src.split(/\r?\n/)) {
    const header = line.match(/^###\s+SOP-(\d+)(?:\s|$)/);
    if (header) {
      sop = `sop${header[1]}`;
      continue;
    }
    const item = line.match(/^\s*-\s+\[\s?\]\s+(\d+\.\d+)\s+(.*)$/);
    if (item && sop) {
      items.push({ sop, key: item[1], label: item[2].trim() });
    }
  }
  return items;
}

describe('parseSopItems', () => {
  it('parses LF line endings', () => {
    const src = ['### SOP-1 注册账户', '', '- [ ] 1.1 填写注册表单', '- [ ] 1.2 验证码 stub'].join('\n');
    const items = parseSopItems(src);
    assert.equal(items.length, 2);
    assert.deepEqual(items[0], { sop: 'sop1', key: '1.1', label: '填写注册表单' });
    assert.deepEqual(items[1], { sop: 'sop1', key: '1.2', label: '验证码 stub' });
  });

  it('parses CRLF line endings (Windows)', () => {
    // Regression guard: this is the exact bug found on 2026-04-23 — \r made .*$ fail in the parser.
    const src = ['### SOP-2 邀请成员', '', '- [ ] 2.1 邀请表单', '- [ ] 2.2 邀请落库'].join('\r\n');
    const items = parseSopItems(src);
    assert.equal(items.length, 2);
    assert.equal(items[0].sop, 'sop2');
    assert.equal(items[0].label, '邀请表单');
    assert.equal(items[1].label, '邀请落库');
  });

  it('attributes items to the most recent SOP header', () => {
    const src = [
      '### SOP-3 广告账户授权',
      '- [ ] 3.1 GDT 授权',
      '### SOP-4 企业微信授权',
      '- [ ] 4.1 发起企微授权',
      '- [ ] 4.3 断言授权列表',
    ].join('\n');
    const items = parseSopItems(src);
    assert.equal(items.length, 3);
    assert.equal(items[0].sop, 'sop3');
    assert.equal(items[1].sop, 'sop4');
    assert.equal(items[2].sop, 'sop4');
  });

  it('ignores non-checkbox bullets and commentary', () => {
    const src = [
      '### SOP-5 企业微信业务',
      '**说明**：一些背景',
      '- 普通的 bullet，不是 checkbox',
      '- [x] 5.0 已完成的，不计入 pending',
      '- [ ] 5.1 真实条目',
    ].join('\n');
    const items = parseSopItems(src);
    // `[x]` is not part of the pending-task count — only `[ ]` items are tracked here.
    assert.equal(items.length, 1);
    assert.equal(items[0].key, '5.1');
  });

  it('ignores content before the first SOP header', () => {
    const src = ['# Preamble', '- [ ] 0.1 unreachable', '### SOP-1 目标', '- [ ] 1.1 真正的第一项'].join('\n');
    const items = parseSopItems(src);
    assert.equal(items.length, 1);
    assert.equal(items[0].sop, 'sop1');
    assert.equal(items[0].key, '1.1');
  });
});

describe('file I/O smoke', () => {
  it('round-trips a tasks.md fixture unchanged across line-ending flavours', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-report-test-'));
    try {
      const content = '### SOP-1\n- [ ] 1.1 foo\n- [ ] 1.2 bar\n';
      const lf = join(dir, 'lf.md');
      const crlf = join(dir, 'crlf.md');
      writeFileSync(lf, content);
      writeFileSync(crlf, content.replace(/\n/g, '\r\n'));

      const lfItems = parseSopItems(readFileSync(lf, 'utf-8'));
      const crlfItems = parseSopItems(readFileSync(crlf, 'utf-8'));

      assert.equal(lfItems.length, crlfItems.length);
      assert.deepEqual(lfItems, crlfItems);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
