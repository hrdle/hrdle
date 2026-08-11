import { describe, expect, test, beforeAll, afterAll } from 'bun:test';
import { FileService } from '../../src/services/file-service';
import { mkdtemp, realpath, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('FileService', () => {
  let fileService: FileService;
  let testDir: string;

  beforeAll(async () => {
    fileService = new FileService();
    // Create a temporary test directory.
    // Resolve symlinks (e.g. macOS /var -> /private/var) so comparisons
    // against validatePath's realpath output are stable
    testDir = await realpath(await mkdtemp(join(tmpdir(), 'hrdle-test-')));

    // Create test files and directories
    await mkdir(join(testDir, 'subdir'));
    await writeFile(join(testDir, 'test.txt'), 'Hello World');
    await writeFile(join(testDir, 'test.ts'), 'const x = 1;');
    await writeFile(join(testDir, 'image.png'), Buffer.from([0x89, 0x50, 0x4E, 0x47])); // PNG header
    await writeFile(join(testDir, '.hidden'), 'hidden file');
    await writeFile(join(testDir, 'subdir', 'nested.txt'), 'nested content');
  });

  afterAll(async () => {
    // Clean up test directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('validatePath', () => {
    test('should allow paths within allowed base', async () => {
      const result = await fileService.validatePath(join(testDir, 'test.txt'), testDir);
      expect(result).toBe(join(testDir, 'test.txt'));
    });

    test('should allow the base directory itself', async () => {
      const result = await fileService.validatePath(testDir, testDir);
      expect(result).toBe(testDir);
    });

    test('should reject paths outside allowed base', async () => {
      const result = await fileService.validatePath('/etc/passwd', testDir);
      expect(result).toBeNull();
    });

    test('should reject path traversal attempts', async () => {
      const result = await fileService.validatePath(join(testDir, '..', '..', 'etc', 'passwd'), testDir);
      expect(result).toBeNull();
    });

    test('should return null for non-existent paths', async () => {
      const result = await fileService.validatePath(join(testDir, 'nonexistent.txt'), testDir);
      expect(result).toBeNull();
    });
  });

  describe('listDirectory', () => {
    test('should list files and directories', async () => {
      const files = await fileService.listDirectory(testDir, testDir);

      expect(files.length).toBeGreaterThan(0);

      // Check that directories come first
      const dirIndex = files.findIndex(f => f.name === 'subdir');
      const fileIndex = files.findIndex(f => f.name === 'test.txt');
      expect(dirIndex).toBeLessThan(fileIndex);
    });

    test('should include file metadata', async () => {
      const files = await fileService.listDirectory(testDir, testDir);
      const testFile = files.find(f => f.name === 'test.txt');

      expect(testFile).toBeDefined();
      expect(testFile?.type).toBe('file');
      expect(testFile?.size).toBeGreaterThan(0);
      expect(testFile?.modifiedAt).toBeDefined();
      expect(testFile?.extension).toBe('.txt');
    });

    test('should identify hidden files', async () => {
      const files = await fileService.listDirectory(testDir, testDir);
      const hiddenFile = files.find(f => f.name === '.hidden');

      expect(hiddenFile).toBeDefined();
      expect(hiddenFile?.isHidden).toBe(true);
    });

    test('should throw for paths outside allowed base', async () => {
      await expect(fileService.listDirectory('/etc', testDir)).rejects.toThrow('Access denied');
    });
  });

  describe('readFile', () => {
    test('should read text files as utf-8', async () => {
      const content = await fileService.readFile(join(testDir, 'test.txt'), testDir);

      expect(content.content).toBe('Hello World');
      expect(content.encoding).toBe('utf-8');
      expect(content.mimeType).toBe('text/plain');
      expect(content.truncated).toBe(false);
    });

    test('should read TypeScript files with correct mime type', async () => {
      const content = await fileService.readFile(join(testDir, 'test.ts'), testDir);

      expect(content.content).toBe('const x = 1;');
      expect(content.mimeType).toBe('text/typescript');
    });

    test('should read binary files as base64', async () => {
      const content = await fileService.readFile(join(testDir, 'image.png'), testDir);

      expect(content.encoding).toBe('base64');
      expect(content.mimeType).toBe('image/png');
    });

    test('should truncate large files', async () => {
      // Create a large file
      const largeContent = 'x'.repeat(2000);
      await writeFile(join(testDir, 'large.txt'), largeContent);

      const content = await fileService.readFile(join(testDir, 'large.txt'), testDir, 1000);

      expect(content.truncated).toBe(true);
      expect(content.content.length).toBe(1000);
    });

    test('should throw for directories', async () => {
      await expect(fileService.readFile(join(testDir, 'subdir'), testDir)).rejects.toThrow('Cannot read directory');
    });

    test('should throw for paths outside allowed base', async () => {
      await expect(fileService.readFile('/etc/passwd', testDir)).rejects.toThrow('Access denied');
    });
  });

  describe('getParentPath', () => {
    test('should return parent directory', () => {
      const parent = fileService.getParentPath(join(testDir, 'subdir'), testDir);
      expect(parent).toBe(testDir);
    });

    test('should return null when at allowed base', () => {
      const parent = fileService.getParentPath(testDir, testDir);
      expect(parent).toBeNull();
    });

    test('should return null when parent is outside allowed base', () => {
      const parent = fileService.getParentPath(testDir, join(testDir, 'subdir'));
      expect(parent).toBeNull();
    });
  });

  describe('getLanguageFromPath', () => {
    test('should return correct language for TypeScript', () => {
      expect(fileService.getLanguageFromPath('file.ts')).toBe('typescript');
      expect(fileService.getLanguageFromPath('file.tsx')).toBe('tsx');
    });

    test('should return correct language for JavaScript', () => {
      expect(fileService.getLanguageFromPath('file.js')).toBe('javascript');
      expect(fileService.getLanguageFromPath('file.jsx')).toBe('jsx');
    });

    test('should return plaintext for unknown extensions', () => {
      expect(fileService.getLanguageFromPath('file.xyz')).toBe('plaintext');
    });
  });

  describe('isImage', () => {
    test('should return true for image files', () => {
      expect(fileService.isImage('photo.png')).toBe(true);
      expect(fileService.isImage('photo.jpg')).toBe(true);
      expect(fileService.isImage('photo.gif')).toBe(true);
      expect(fileService.isImage('photo.webp')).toBe(true);
    });

    test('should return false for non-image files', () => {
      expect(fileService.isImage('file.txt')).toBe(false);
      expect(fileService.isImage('file.ts')).toBe(false);
    });
  });

  describe('isTextFile', () => {
    test('should return true for text files', () => {
      expect(fileService.isTextFile('file.txt')).toBe(true);
      expect(fileService.isTextFile('file.ts')).toBe(true);
      expect(fileService.isTextFile('file.md')).toBe(true);
    });

    test('should return false for binary files', () => {
      expect(fileService.isTextFile('file.png')).toBe(false);
      expect(fileService.isTextFile('file.zip')).toBe(false);
    });
  });
});
