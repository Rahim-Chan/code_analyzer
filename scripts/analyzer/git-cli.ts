import { program } from 'commander';
import { simpleGit } from 'simple-git';
import { spawn } from 'child_process';
import path from 'path';
import { parseFile } from './parser';
import { FileChange } from './types';

program
  .option('-e, --entry <path>', 'Entry file path', 'src/main.tsx')
  .option('-r, --range <range>', 'Git diff range (e.g., HEAD^..HEAD, commit1..commit2)', 'HEAD^..HEAD')
  .option('-d, --detailed', 'Include detailed content analysis', false)
  .parse(process.argv);

const options = program.opts();

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string[];
}

interface FileDiff {
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

async function parseGitDiff(diff: string): Promise<Map<string, FileDiff>> {
  const files = new Map<string, FileDiff>();
  let currentFile: string | null = null;
  let currentHunk: DiffHunk | null = null;
  
  const lines = diff.split('\n');
  
  for (const line of lines) {
    // New file
    if (line.startsWith('diff --git')) {
      if (currentFile && currentHunk) {
        const fileDiff = files.get(currentFile);
        if (fileDiff) {
          fileDiff.hunks.push(currentHunk);
        }
      }
      currentHunk = null;
      continue;
    }
    
    // File name
    if (line.startsWith('+++') || line.startsWith('---')) {
      const filePath = line.slice(4);
      if (line.startsWith('+++') && filePath !== '/dev/null') {
        currentFile = filePath.replace('b/', '');
        if (!files.has(currentFile)) {
          files.set(currentFile, {
            hunks: [],
            additions: 0,
            deletions: 0
          });
        }
      }
      continue;
    }
    
    // Hunk header
    if (line.startsWith('@@')) {
      if (currentFile && currentHunk) {
        const fileDiff = files.get(currentFile);
        if (fileDiff) {
          fileDiff.hunks.push(currentHunk);
        }
      }
      
      const match = line.match(/@@ -(\d+),?(\d+)? \+(\d+),?(\d+)? @@/);
      if (match && currentFile) {
        currentHunk = {
          oldStart: parseInt(match[1], 10),
          oldLines: match[2] ? parseInt(match[2], 10) : 0,
          newStart: parseInt(match[3], 10),
          newLines: match[4] ? parseInt(match[4], 10) : 0,
          content: []
        };
      }
      continue;
    }
    
    // Content lines
    if (currentFile && currentHunk && line.length > 0) {
      currentHunk.content.push(line);
      const fileDiff = files.get(currentFile);
      if (fileDiff) {
        if (line.startsWith('+')) fileDiff.additions++;
        if (line.startsWith('-')) fileDiff.deletions++;
      }
    }
  }
  
  // Add last hunk
  if (currentFile && currentHunk) {
    const fileDiff = files.get(currentFile);
    if (fileDiff) {
      fileDiff.hunks.push(currentHunk);
    }
  }
  
  return files;
}

async function getGitChanges(range: string, detailed: boolean): Promise<FileChange[]> {
  const git = simpleGit();
  const [fromRef, toRef] = range.split('..');
  
  if (!fromRef || !toRef) {
    throw new Error('Invalid git range format. Use format: commit1..commit2');
  }

  const changes: FileChange[] = [];
  
  // Get basic file status
  const statusDiff = await git.diff([fromRef, toRef, '--name-status']);
  const changedFiles = new Map(
    statusDiff
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [status, filePath] = line.split('\t');
        return [filePath, status[0]] as [string, string];
      })
  );

  if (detailed) {
    // Get detailed diff
    const contentDiff = await git.diff([fromRef, toRef, '-U0']);
    const fileDiffs = await parseGitDiff(contentDiff);

    for (const [filePath, status] of changedFiles.entries()) {
      if (!filePath.match(/\.(js|jsx|ts|tsx)$/)) continue;

      const absolutePath = path.resolve(process.cwd(), filePath);
      let changeType: 'add' | 'modify' | 'delete';
      let modifiedExports: string[] = [];
      let contentChanges: any = {};

      const fileDiff = fileDiffs.get(filePath);
      if (fileDiff) {
        contentChanges = {
          additions: fileDiff.additions,
          deletions: fileDiff.deletions,
          hunks: fileDiff.hunks.map(hunk => ({
            oldStart: hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart,
            newLines: hunk.newLines,
            changes: hunk.content
              .filter(line => line.startsWith('+') || line.startsWith('-'))
              .map(line => ({
                type: line.startsWith('+') ? 'addition' : 'deletion',
                content: line.slice(1)
              }))
          }))
        };
      }

      switch (status) {
        case 'A':
          changeType = 'add';
          break;
        case 'D':
          changeType = 'delete';
          break;
        case 'M':
          changeType = 'modify';
          try {
            // Get previous exports
            const prevExports = new Set<string>();
            const prevContent = await git.show([`${fromRef}:${filePath}`]);
            if (prevContent) {
              const { exports } = await parseFile(absolutePath, prevContent);
              exports.forEach(exp => prevExports.add(exp));
            }

            // Get current exports
            let currentExports = new Set<string>();
            try {
              const currentContent = await git.show([`${toRef}:${filePath}`]);
              if (currentContent) {
                const { exports } = await parseFile(absolutePath, currentContent);
                currentExports = exports;
              }
            } catch (error) {
              const { exports } = await parseFile(absolutePath);
              currentExports = exports;
            }
            
            modifiedExports = Array.from(currentExports).filter(exp => !prevExports.has(exp))
              .concat(Array.from(prevExports).filter(exp => !currentExports.has(exp)));
            
          } catch (error) {
            console.warn(`Warning: Could not analyze exports for ${filePath}:`, error);
          }
          break;
        default:
          continue;
      }

      changes.push({
        changedFile: absolutePath,
        changeType,
        modifiedExports: modifiedExports.length > 0 ? modifiedExports : undefined,
        contentChanges: detailed ? contentChanges : undefined
      });
    }
  } else {
    // Simple mode without content analysis
    for (const [filePath, status] of changedFiles.entries()) {
      if (!filePath.match(/\.(js|jsx|ts|tsx)$/)) continue;

      const absolutePath = path.resolve(process.cwd(), filePath);
      const changeType = status === 'A' ? 'add' : status === 'D' ? 'delete' : 'modify';

      changes.push({
        changedFile: absolutePath,
        changeType,
        modifiedExports: undefined
      });
    }
  }

  return changes;
}

async function main() {
  try {
    const changes = await getGitChanges(options.range, options.detailed);
    
    if (changes.length === 0) {
      console.log('No relevant file changes found in the specified range.');
      return;
    }

    console.log('\nAnalyzing changes between:', options.range);
    console.log('Changed files:', changes.length);
    
    if (options.detailed) {
      console.log('\nDetailed changes:');
      for (const change of changes) {
        console.log(`\n${change.changedFile} (${change.changeType.toUpperCase()})`);
        if (change.contentChanges) {
          console.log(`  Changes: +${change.contentChanges.additions} -${change.contentChanges.deletions}`);
          for (const hunk of change.contentChanges.hunks) {
            console.log(`  @@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
            for (const change of hunk.changes) {
              console.log(`    ${change.type === 'addition' ? '+' : '-'}${change.content}`);
            }
          }
        }
        if (change.modifiedExports?.length) {
          console.log('  Modified exports:', change.modifiedExports.join(', '));
        }
      }
    }
    
    console.log('\n----------------------------------------\n');

    // Run the analyzer CLI with the detected changes
    const analyzerProcess = spawn('npm', [
      'run',
      'analyze',
      '--',
      '-e',
      options.entry,
      '-f',
      JSON.stringify(changes)
    ], {
      stdio: 'inherit',
      shell: true
    });

    analyzerProcess.on('error', (error) => {
      console.error('Failed to run analyzer:', error);
      process.exit(1);
    });

  } catch (error: any) {
    console.error('Error analyzing git changes:', error.message);
    process.exit(1);
  }
}

main().catch(console.error);