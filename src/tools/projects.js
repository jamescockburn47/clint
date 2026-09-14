// src/tools/projects.js — Project management tools for persistent project definitions
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import logger from '../logger.js';
import { runtimePath } from '../overnight/paths.js';
import { permitsProject } from '../conversation-context.js';
import { resolveProjectFile } from '../project-file-boundary.js';

// Post Phase 0 spec §6.1 P1: runtime state lives in data/runtime/
const PROJECTS_FILE = runtimePath('projects.json');
const DEFAULT_PROJECTS_FILE = join(process.cwd(), 'data', 'runtime-defaults', 'projects.json');

function loadProjects() {
  try {
    if (!existsSync(PROJECTS_FILE)) return [];
    const data = JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));
    return data.projects || [];
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to load projects');
    return [];
  }
}

function loadDefaultProjects() {
  try {
    if (!existsSync(DEFAULT_PROJECTS_FILE)) return [];
    const data = JSON.parse(readFileSync(DEFAULT_PROJECTS_FILE, 'utf-8'));
    return data.projects || [];
  } catch (err) {
    logger.warn({ err: err.message }, 'failed to load default projects');
    return [];
  }
}

function getMergedProjects() {
  const runtimeProjects = loadProjects();
  const defaultsById = new Map(loadDefaultProjects().map((project) => [project.id, project]));
  const merged = runtimeProjects.map((project) => ({
    ...(defaultsById.get(project.id) || {}),
    ...project,
  }));
  for (const [id, fallbackProject] of defaultsById.entries()) {
    if (!merged.some((project) => project.id === id)) {
      merged.push(fallbackProject);
    }
  }
  return merged.filter(project => permitsProject(project.id));
}

function saveProjects(projects) {
  writeFileSync(PROJECTS_FILE, JSON.stringify({ projects }, null, 2));
}

/**
 * Returns the current runtime projects list.
 * Used by prompt-time project scoping and diagnostics.
 */
export function getProjectsSnapshot() {
  return getMergedProjects();
}

/**
 * Returns a single project by ID or null.
 */
export function getProjectById(projectId) {
  const projects = getMergedProjects();
  return projects.find((project) => project.id === projectId) || null;
}

export async function projectList() {
  const projects = getMergedProjects();
  if (projects.length === 0) return 'No projects defined yet.';

  return projects.map(p => {
    const status = p.status ? ` [${p.status.toUpperCase()}]` : '';
    return `**${p.name}**${status}\n${p.oneLiner || p.summary?.slice(0, 150) || 'No description'}`;
  }).join('\n\n');
}

// Internal sections — only shown when explicitly requested, never in public-facing output
const INTERNAL_SECTIONS = ['criticalFeedback', 'lastDeepThink', 'safetyConsiderations'];
const READABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.json', '.yaml', '.yml', '.js', '.ts', '.tsx', '.py', '.sql', '.csv', '.toml', '.ini',
]);
const DEFAULT_MAX_CHARS = 9000;
const DEFAULT_LIST_LIMIT = 60;

export async function projectRead({ id, section }) {
  const projects = getMergedProjects();
  const project = projects.find(p => p.id === id);
  if (!project) return `Project "${id}" not found. Use project_list to see available projects.`;

  // If a specific section requested, return just that (including internal sections)
  if (section) {
    const val = project[section];
    if (val === undefined) return `Section "${section}" not found in project "${id}". Available sections: ${Object.keys(project).join(', ')}`;
    if (typeof val === 'string') return `**${project.name} — ${section}**\n\n${val}`;
    return `**${project.name} — ${section}**\n\n${JSON.stringify(val, null, 2)}`;
  }

  // Full project view
  let out = `# ${project.name}\n`;
  out += `**Status:** ${project.status || 'unknown'}\n`;
  out += `**Created:** ${project.created || 'unknown'}\n\n`;

  if (project.oneLiner) out += `> ${project.oneLiner}\n\n`;
  if (project.summary) out += `${project.summary}\n\n`;
  if (project.foundingInsight) out += `**Founding Insight:** ${project.foundingInsight}\n\n`;

  // Existing primitives (for AGI project)
  if (project.existingPrimitives) {
    out += `## What Already Exists\n`;
    for (const p of project.existingPrimitives) {
      out += `- **${p.name}** — ${p.description}\n`;
    }
    out += '\n';
  }

  // Architecture layers
  if (project.architecture?.layers) {
    out += `## Architecture\n`;
    for (const layer of project.architecture.layers) {
      const status = layer.status ? ` [${layer.status}]` : '';
      out += `\n**${layer.name}**${status}\n${layer.description}\n`;
      if (layer.agents) {
        for (const agent of layer.agents) {
          out += `- ${agent}\n`;
        }
      }
      if (layer.components) {
        for (const comp of layer.components) {
          out += `- ${comp}\n`;
        }
      }
      if (layer.outputs) {
        out += `\nOutputs:\n`;
        for (const output of layer.outputs) {
          out += `- ${output}\n`;
        }
      }
    }
  }

  // Critical gaps
  if (project.criticalGaps) {
    out += `\n## Critical Gaps\n`;
    for (const g of project.criticalGaps) {
      out += `- ${g}\n`;
    }
  }

  // NOTE: criticalFeedback is INTERNAL — only shown via project_read with section='criticalFeedback'
  // Never include in default view or pitches — it's strategic intel, not public information

  // Key differentiators
  if (project.keyDifferentiators) {
    out += `\n## Key Differentiators\n`;
    for (const d of project.keyDifferentiators) {
      out += `- ${d}\n`;
    }
  }

  // Safety
  if (project.safetyConsiderations) {
    const s = project.safetyConsiderations;
    out += `\n## Safety\n`;
    if (s.alignmentMechanism) out += `**Alignment:** ${s.alignmentMechanism}\n`;
    if (s.warning) out += `**Warning:** ${s.warning}\n`;
    if (s.soulProtection) out += `**Soul Protection:** ${s.soulProtection}\n`;
  }

  // Partners
  if (project.potentialPartners) {
    out += `\n## Potential Partners\n`;
    for (const p of project.potentialPartners) {
      out += `**${p.name}** (${p.founder}): ${p.description}\nIntegration: ${p.integrationValue}\n\n`;
    }
  }

  // Next steps
  if (project.nextSteps) {
    out += `## Next Steps\n`;
    for (const s of project.nextSteps) {
      out += `- ${s}\n`;
    }
  }

  return out;
}

export async function projectPitch({ id, audience }) {
  const projects = getMergedProjects();
  const project = projects.find(p => p.id === id);
  if (!project) return `Project "${id}" not found.`;

  // Return a structured context block for Claude to formulate a pitch from
  let context = `PITCH CONTEXT FOR: ${project.name}\n`;
  context += `Audience: ${audience || 'general'}\n\n`;
  context += `One-liner: ${project.oneLiner}\n\n`;
  context += `Summary: ${project.summary}\n\n`;
  context += `Founding insight: ${project.foundingInsight}\n\n`;

  if (project.architecture?.layers) {
    context += `Architecture layers:\n`;
    for (const layer of project.architecture.layers) {
      context += `- ${layer.name}: ${layer.description}\n`;
    }
  }

  if (project.keyDifferentiators) {
    context += `\nKey differentiators:\n`;
    for (const d of project.keyDifferentiators) {
      context += `- ${d}\n`;
    }
  }

  if (project.potentialPartners) {
    context += `\nPotential partners:\n`;
    for (const p of project.potentialPartners) {
      context += `- ${p.name} (${p.founder}): ${p.integrationValue}\n`;
    }
  }

  context += `\nDELIVER A TAILORED PITCH based on the above. Focus on what matters to the audience. Be direct and compelling.`;
  return context;
}

export async function projectUpdate({ id, field, value }) {
  const projects = loadProjects();
  const idx = projects.findIndex(p => p.id === id);
  if (idx === -1) return `Project "${id}" not found.`;

  // Only allow updating top-level string fields and nextSteps/tags arrays
  const safeFields = ['status', 'summary', 'oneLiner', 'foundingInsight'];
  const arrayFields = ['nextSteps', 'tags', 'keyDifferentiators'];

  if (safeFields.includes(field)) {
    projects[idx][field] = value;
  } else if (arrayFields.includes(field)) {
    // Append to array
    if (!Array.isArray(projects[idx][field])) projects[idx][field] = [];
    projects[idx][field].push(value);
  } else {
    return `Cannot update field "${field}". Allowed: ${[...safeFields, ...arrayFields].join(', ')}`;
  }

  projects[idx].updated = new Date().toISOString();
  saveProjects(projects);
  logger.info({ projectId: id, field }, 'project updated');
  return `Updated ${field} on ${projects[idx].name}.`;
}

function resolveProjectRoot(project) {
  if (!project) return null;
  const roots = [project.evoPath, project.localPath]
    .filter(Boolean)
    .map((p) => String(p));
  for (const rawPath of roots) {
    const expanded = rawPath.startsWith('~/')
      ? join(homedir(), rawPath.slice(2))
      : rawPath;
    const absolute = isAbsolute(expanded) ? expanded : resolve(expanded);
    if (existsSync(absolute)) return absolute;
  }
  return null;
}

function ensurePathWithinRoot(root, relPath) {
  return resolveProjectFile(root, relPath);
}

export async function projectListFiles({ id, subpath = '.', limit = DEFAULT_LIST_LIMIT }) {
  const project = getProjectById(id);
  if (!project) return `Project "${id}" not found.`;
  const root = resolveProjectRoot(project);
  if (!root) return `Project root for "${id}" not found on this machine.`;

  let targetDir;
  try {
    targetDir = ensurePathWithinRoot(root, subpath);
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid path.';
  }
  if (!existsSync(targetDir)) return `Path not found: ${subpath}`;

  const entries = readdirSync(targetDir, { withFileTypes: true })
    .slice(0, Number(limit) || DEFAULT_LIST_LIMIT)
    .map((entry) => (entry.isDirectory() ? `[dir] ${entry.name}` : entry.name));

  if (entries.length === 0) return `No files found under ${subpath}.`;
  return `Project: ${project.name}\nRoot: ${root}\nPath: ${subpath}\n\n${entries.join('\n')}`;
}

export async function projectFileRead({ id, path, max_chars = DEFAULT_MAX_CHARS }) {
  const project = getProjectById(id);
  if (!project) return `Project "${id}" not found.`;
  if (!path) return 'path is required.';
  const root = resolveProjectRoot(project);
  if (!root) return `Project root for "${id}" not found on this machine.`;

  let targetFile;
  try {
    targetFile = ensurePathWithinRoot(root, path);
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid path.';
  }
  if (!existsSync(targetFile)) return `File not found: ${path}`;
  if (statSync(targetFile).isDirectory()) return 'Path is a directory. Use project_list_files first.';

  const ext = extname(targetFile).toLowerCase();
  if (!READABLE_EXTENSIONS.has(ext)) {
    return `Unsupported file type "${ext || 'unknown'}". Readable types: ${[...READABLE_EXTENSIONS].join(', ')}`;
  }

  const text = readFileSync(targetFile, 'utf-8');
  const maxChars = Number(max_chars) > 0 ? Number(max_chars) : DEFAULT_MAX_CHARS;
  const output = text.length > maxChars ? `${text.slice(0, maxChars)}\n\n[...truncated]` : text;
  return `Project: ${project.name}\nFile: ${path}\n\n${output}`;
}
