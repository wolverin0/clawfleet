#!/usr/bin/env node
/**
 * task-parser.cjs — parses active_tasks.md into structured task objects.
 *
 * Format expected:
 *   ## T-NNN · Title
 *   ```yaml
 *   status: ...
 *   owner: ...
 *   ...
 *   ```
 *
 * Returns { tasks: Map<id, task>, errors: [] } where each task is:
 *   { id, title, status, owner, created_at, ...rawYamlFields, _line }
 */

const fs = require('fs');

function parseYamlBlock(text) {
  // Minimal YAML parser for the subset we use: key: value | key: | list items
  // Supports:
  //   key: scalar
  //   key: "quoted scalar"
  //   key: [item1, item2]
  //   key:
  //     - item1
  //     - item2
  //   key: |
  //     multi-line
  //     string
  const out = {};
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || line.trim().startsWith('#')) { i++; continue; }

    const kvMatch = line.match(/^(\w+):\s*(.*)$/);
    if (!kvMatch) { i++; continue; }
    const key = kvMatch[1];
    const valRaw = kvMatch[2];

    if (valRaw === '|' || valRaw === '>') {
      // Multi-line string block: collect indented lines
      const buf = [];
      i++;
      while (i < lines.length && (lines[i].startsWith('  ') || lines[i].trim() === '')) {
        buf.push(lines[i].replace(/^  /, ''));
        i++;
      }
      out[key] = buf.join('\n').trim();
      continue;
    }

    if (valRaw === '') {
      // Either a block list or empty value; peek next lines
      const list = [];
      let j = i + 1;
      while (j < lines.length && /^\s*- /.test(lines[j])) {
        list.push(lines[j].replace(/^\s*- /, '').trim().replace(/^["']|["']$/g, ''));
        j++;
      }
      if (list.length > 0) {
        out[key] = list;
        i = j;
        continue;
      }
      out[key] = '';
      i++;
      continue;
    }

    if (valRaw.startsWith('[') && valRaw.endsWith(']')) {
      // Inline list
      const inner = valRaw.slice(1, -1).trim();
      if (!inner) out[key] = [];
      else out[key] = inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
      i++;
      continue;
    }

    // Scalar: strip quotes
    let v = valRaw.trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    // Coerce numbers
    if (/^-?\d+$/.test(v)) out[key] = parseInt(v, 10);
    else if (/^-?\d+\.\d+$/.test(v)) out[key] = parseFloat(v);
    else if (v === 'true') out[key] = true;
    else if (v === 'false') out[key] = false;
    else out[key] = v;
    i++;
  }
  return out;
}

function parseTasksFile(filePath) {
  const result = { tasks: new Map(), errors: [] };
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    result.errors.push(`Cannot read ${filePath}: ${err.message}`);
    return result;
  }

  const lines = content.split('\n');
  let i = 0;
  while (i < lines.length) {
    const headingMatch = lines[i].match(/^##\s+(T-\d+)\s*·\s*(.+?)\s*$/);
    if (!headingMatch) { i++; continue; }

    const id = headingMatch[1];
    const title = headingMatch[2];
    const headingLine = i + 1;

    // Find next ```yaml block
    let j = i + 1;
    while (j < lines.length && !lines[j].match(/^```ya?ml\s*$/)) {
      if (lines[j].match(/^##\s+/)) break; // Hit next task without a yaml block
      j++;
    }

    if (j >= lines.length || !lines[j].match(/^```ya?ml\s*$/)) {
      result.errors.push(`Task ${id} at line ${headingLine}: missing yaml block`);
      i = j;
      continue;
    }

    const yamlStart = j + 1;
    let yamlEnd = yamlStart;
    while (yamlEnd < lines.length && !lines[yamlEnd].match(/^```\s*$/)) yamlEnd++;

    if (yamlEnd >= lines.length) {
      result.errors.push(`Task ${id} at line ${headingLine}: unclosed yaml block`);
      i = yamlEnd;
      continue;
    }

    const yamlText = lines.slice(yamlStart, yamlEnd).join('\n');
    const fields = parseYamlBlock(yamlText);

    result.tasks.set(id, {
      id,
      title,
      _line: headingLine,
      ...fields,
    });

    i = yamlEnd + 1;
  }

  return result;
}

module.exports = { parseTasksFile, parseYamlBlock };

// CLI: node task-parser.cjs <file> → print JSON
if (require.main === module) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node task-parser.cjs <active_tasks.md>');
    process.exit(1);
  }
  const result = parseTasksFile(file);
  const obj = {
    errors: result.errors,
    tasks: Object.fromEntries(result.tasks),
  };
  console.log(JSON.stringify(obj, null, 2));
}
