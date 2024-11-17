import { AnalysisOptions, FileNode, ImportInfo, FileChange, DependencyContext } from './types';
import { isJavaScriptFile, isAssetFile, shouldIgnoreFile, resolveImportPath } from './utils';
import { parseFile } from './parser';
import path from 'path';
import fs from 'fs/promises';

export async function analyzeProject(options: AnalysisOptions): Promise<FileNode> {
  const { entryFile, changes } = options;
  const rootDir = process.cwd();
  
  try {
    await fs.access(entryFile);
    
    const depContext: DependencyContext = {
      affectedFiles: new Set(),
      reverseDependencies: new Map()
    };

    const tree = await buildDependencyTree(entryFile, {
      changes,
      rootDir,
      visited: new Set(),
      depContext
    });
    
    return tree;
  } catch (error) {
    console.error('Error analyzing project:', error);
    throw new Error(`Failed to analyze project: ${error.message}`);
  }
}

async function buildDependencyTree(
  filePath: string,
  context: {
    changes: FileChange[];
    rootDir: string;
    visited: Set<string>;
    depContext: DependencyContext;
  }
): Promise<FileNode> {
  const { changes, rootDir, visited, depContext } = context;

  if (visited.has(filePath)) {
    return {
      file: filePath,
      type: isJavaScriptFile(filePath) ? 'js' : 'asset',
      children: []
    };
  }

  visited.add(filePath);

  try {
    await fs.access(filePath);
    
    const node: FileNode = {
      file: filePath,
      type: isJavaScriptFile(filePath) ? 'js' : 'asset',
      children: []
    };

    // Check if this is one of the changed files
    const change = changes.find(c => c.changedFile === filePath);
    if (change) {
      node.changeType = change.changeType;
      node.reason = `File was ${change.changeType}d`;
      depContext.affectedFiles.add(filePath);
    }

    if (node.type === 'js' && !shouldIgnoreFile(filePath)) {
      try {
        const { imports, exports } = await parseFile(filePath);
        node.imports = imports;
        node.exports = exports;

        // Build reverse dependencies
        for (const imp of imports) {
          const resolvedPath = resolveImportPath(filePath, imp.source, rootDir);
          if (resolvedPath) {
            if (!depContext.reverseDependencies.has(resolvedPath)) {
              depContext.reverseDependencies.set(resolvedPath, new Set());
            }
            depContext.reverseDependencies.get(resolvedPath)?.add(filePath);
          }
        }

        // Process imports
        const childPromises = imports.map(async (imp) => {
          const resolvedPath = resolveImportPath(filePath, imp.source, rootDir);
          if (resolvedPath) {
            try {
              await fs.access(resolvedPath);
              return await buildDependencyTree(resolvedPath, context);
            } catch {
              console.warn(`Warning: Could not access imported file: ${resolvedPath}`);
              return null;
            }
          }
          return null;
        });

        const children = (await Promise.all(childPromises)).filter((child): child is FileNode => child !== null);
        node.children = children;

        // Check if this file is affected by any of the changes
        const affectingChanges = determineAffectingChanges(filePath, {
          changes,
          imports,
          rootDir,
          depContext
        });

        if (affectingChanges.length > 0) {
          node.isAffected = true;
          node.reason = determineImpactReason(filePath, affectingChanges);
          depContext.affectedFiles.add(filePath);
          propagateChanges(filePath, depContext);
        }

      } catch (error) {
        console.warn(`Warning: Error analyzing file ${filePath}:`, error);
      }
    } else if (node.type === 'asset') {
      if (change) {
        node.isAffected = true;
        node.reason = `Asset file was ${change.changeType}d`;
        depContext.affectedFiles.add(filePath);
      }
    }

    return node;
  } catch (error) {
    console.warn(`Warning: Could not access file ${filePath}:`, error);
    return {
      file: filePath,
      type: 'asset',
      children: []
    };
  }
}

interface AffectingImport {
  change: FileChange;
  importedSpecifiers: string[];
  indirect?: boolean;
}

function propagateChanges(filePath: string, depContext: DependencyContext) {
  const dependents = depContext.reverseDependencies.get(filePath);
  if (!dependents) return;

  for (const dependent of dependents) {
    if (!depContext.affectedFiles.has(dependent)) {
      depContext.affectedFiles.add(dependent);
      propagateChanges(dependent, depContext);
    }
  }
}

function determineAffectingChanges(
  filePath: string,
  context: {
    changes: FileChange[];
    imports: ImportInfo[];
    rootDir: string;
    depContext: DependencyContext;
  }
): AffectingImport[] {
  const { changes, imports, rootDir, depContext } = context;
  const affectingChanges: AffectingImport[] = [];

  // Check direct dependencies
  for (const change of changes) {
    imports.forEach(imp => {
      const resolvedSource = resolveImportPath(filePath, imp.source, rootDir);
      if (resolvedSource === change.changedFile) {
        if (change.changeType === 'modify' && change.modifiedExports?.length) {
          const affectedSpecifiers = Array.from(imp.specifiers)
            .filter(spec => change.modifiedExports?.includes(spec));
          
          if (affectedSpecifiers.length > 0) {
            affectingChanges.push({
              change,
              importedSpecifiers: affectedSpecifiers
            });
          }
        } else {
          affectingChanges.push({
            change,
            importedSpecifiers: Array.from(imp.specifiers)
          });
        }
      }
    });
  }

  // Check indirect dependencies
  imports.forEach(imp => {
    const resolvedSource = resolveImportPath(filePath, imp.source, rootDir);
    if (resolvedSource && depContext.affectedFiles.has(resolvedSource)) {
      affectingChanges.push({
        change: {
          changedFile: resolvedSource,
          changeType: 'modify',
          modifiedExports: Array.from(imp.specifiers)
        },
        importedSpecifiers: Array.from(imp.specifiers),
        indirect: true
      });
    }
  });

  return affectingChanges;
}

function determineImpactReason(
  filePath: string,
  affectingChanges: AffectingImport[]
): string {
  const reasons: string[] = [];

  for (const { change, importedSpecifiers, indirect } of affectingChanges) {
    const fileName = path.basename(change.changedFile);
    const prefix = indirect ? 'Indirectly' : 'Directly';
    
    switch (change.changeType) {
      case 'delete':
        reasons.push(`${prefix} affected: Imported file '${fileName}' was deleted`);
        break;
      
      case 'add':
        reasons.push(`${prefix} affected: New file '${fileName}' was added that is imported`);
        break;
      
      case 'modify':
        if (change.modifiedExports?.length && importedSpecifiers.length > 0) {
          reasons.push(
            `${prefix} affected by modified exports from '${fileName}': ${importedSpecifiers.join(', ')}`
          );
        } else {
          reasons.push(`${prefix} affected: File '${fileName}' content was modified`);
        }
        break;
    }
  }

  return reasons.join('\n');
}