import * as fs from 'fs';
import * as path from 'path';
import { simpleGit, SimpleGit } from 'simple-git';
import {
  BaselineInfo,
  BaselineMetadata,
  BaselineSaveResult,
  BaselineLoadResult,
  BaselineDeleteResult,
  BaselineCleanupResult
} from './types';

/**
 * BaselineManager handles storage and retrieval of baseline images with git integration
 */
export class BaselineManager {
  private git: SimpleGit;

  constructor(private baselineDir: string) {
    this.git = simpleGit();
  }

  /**
   * Save a baseline image with metadata
   */
  async saveBaseline(
    testName: string,
    imageBuffer: Buffer,
    metadata: BaselineMetadata
  ): Promise<BaselineSaveResult> {
    try {
      // Get current git information
      const branch = metadata.gitBranch || await this.getCurrentBranch();
      const commit = metadata.gitCommit || await this.getCurrentCommit();

      // Generate paths
      const imagePath = this.generateBaselinePath(testName, branch);
      const metadataPath = this.generateMetadataPath(testName, branch);

      // Ensure directory exists
      const dir = path.dirname(imagePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Enhanced metadata with git info
      const enhancedMetadata = {
        ...metadata,
        gitBranch: branch,
        gitCommit: commit,
        savedAt: Date.now(),
      };

      // Save image and metadata
      fs.writeFileSync(imagePath, imageBuffer);
      fs.writeFileSync(metadataPath, JSON.stringify(enhancedMetadata, null, 2));

      return {
        success: true,
        path: imagePath,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Load a baseline image with metadata
   */
  async loadBaseline(testName: string, branch?: string): Promise<BaselineLoadResult> {
    try {
      const targetBranch = branch || await this.getCurrentBranch();

      // Try current branch first, then fallback to main
      const branches = targetBranch === 'main' ? ['main'] : [targetBranch, 'main'];

      for (const branchName of branches) {
        const imagePath = this.generateBaselinePath(testName, branchName);
        const metadataPath = this.generateMetadataPath(testName, branchName);

        if (fs.existsSync(imagePath) && fs.existsSync(metadataPath)) {
          const imageBuffer = fs.readFileSync(imagePath);
          const metadataText = fs.readFileSync(metadataPath, 'utf-8');
          const metadata = JSON.parse(metadataText) as BaselineMetadata;

          return {
            success: true,
            buffer: imageBuffer,
            metadata,
          };
        }
      }

      return {
        success: false,
        error: `Baseline not found for test '${testName}' in branches: ${branches.join(', ')}`,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get information about a baseline without loading the full image
   */
  async getBaselineInfo(testName: string, branch?: string): Promise<BaselineInfo> {
    try {
      const targetBranch = branch || await this.getCurrentBranch();
      const imagePath = this.generateBaselinePath(testName, targetBranch);
      const metadataPath = this.generateMetadataPath(testName, targetBranch);

      if (!fs.existsSync(imagePath)) {
        return { exists: false };
      }

      const stats = fs.statSync(imagePath);
      let metadata: BaselineMetadata | undefined;

      if (fs.existsSync(metadataPath)) {
        try {
          const metadataText = fs.readFileSync(metadataPath, 'utf-8');
          metadata = JSON.parse(metadataText);
        } catch {
          // Ignore metadata parse errors
        }
      }

      return {
        exists: true,
        path: imagePath,
        lastModified: stats.mtime,
        gitBranch: metadata?.gitBranch,
        gitCommit: metadata?.gitCommit,
      };
    } catch {
      return { exists: false };
    }
  }

  /**
   * Delete a baseline image and its metadata
   */
  async deleteBaseline(testName: string, branch?: string): Promise<BaselineDeleteResult> {
    try {
      const targetBranch = branch || await this.getCurrentBranch();
      const imagePath = this.generateBaselinePath(testName, targetBranch);
      const metadataPath = this.generateMetadataPath(testName, targetBranch);

      if (!fs.existsSync(imagePath)) {
        return {
          success: false,
          error: `Baseline not found for test '${testName}' in branch '${targetBranch}'`,
        };
      }

      // Delete image
      fs.unlinkSync(imagePath);

      // Delete metadata if it exists
      if (fs.existsSync(metadataPath)) {
        fs.unlinkSync(metadataPath);
      }

      return {
        success: true,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * List all baseline test names in the current branch
   */
  async listBaselines(branch?: string): Promise<string[]> {
    try {
      const targetBranch = branch || await this.getCurrentBranch();
      const branchDir = path.join(this.baselineDir, targetBranch);

      if (!fs.existsSync(branchDir)) {
        return [];
      }

      const files = fs.readdirSync(branchDir);
      const imageFiles = files.filter(file => path.extname(file) === '.png');

      // Remove extension to get test names
      return imageFiles.map(file => path.basename(file, '.png'));
    } catch {
      return [];
    }
  }

  /**
   * Clean up old baselines older than specified days
   */
  async cleanupOldBaselines(maxAgeDays: number, branch?: string): Promise<BaselineCleanupResult> {
    try {
      const targetBranch = branch || await this.getCurrentBranch();
      const branchDir = path.join(this.baselineDir, targetBranch);

      if (!fs.existsSync(branchDir)) {
        return { success: true, deletedCount: 0 };
      }

      const cutoffDate = new Date();
      cutoffDate.setDate(cutoffDate.getDate() - maxAgeDays);

      const files = fs.readdirSync(branchDir);
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(branchDir, file);
        const stats = fs.statSync(filePath);

        if (stats.isFile() && stats.mtime < cutoffDate) {
          const testName = path.basename(file, path.extname(file));

          // Only count image files for deletion count
          if (path.extname(file) === '.png') {
            const deleteResult = await this.deleteBaseline(testName, targetBranch);
            if (deleteResult.success) {
              deletedCount++;
            }
          }
        }
      }

      return {
        success: true,
        deletedCount,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Generate baseline image path for a test name and branch
   */
  generateBaselinePath(testName: string, branch: string): string {
    const sanitizedTestName = this.sanitizeTestName(testName);
    return path.join(this.baselineDir, branch, `${sanitizedTestName}.png`);
  }

  /**
   * Generate metadata path for a test name and branch
   */
  private generateMetadataPath(testName: string, branch: string): string {
    const sanitizedTestName = this.sanitizeTestName(testName);
    return path.join(this.baselineDir, branch, `${sanitizedTestName}.json`);
  }

  /**
   * Sanitize test name for file system usage
   */
  private sanitizeTestName(testName: string): string {
    return testName
      .replace(/[^a-zA-Z0-9\-_\.]/g, '-') // Replace invalid chars with dash
      .replace(/-+/g, '-') // Replace multiple dashes with single dash
      .replace(/^-|-$/g, ''); // Remove leading/trailing dashes
  }

  /**
   * Get current git branch
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const branchInfo = await this.git.branch();
      return branchInfo.current || 'main';
    } catch {
      return 'main';
    }
  }

  /**
   * Get current git commit hash
   */
  private async getCurrentCommit(): Promise<string> {
    try {
      const log = await this.git.log({ maxCount: 1 });
      return log.latest?.hash || '';
    } catch {
      return '';
    }
  }
}