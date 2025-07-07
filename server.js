const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const { promisify } = require('util');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const yaml = require('js-yaml');
// Removed: const { v4: uuidv4 } = require('uuid');

const execAsync = promisify(exec);
const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Supabase configuration
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// Configuration
const PORT = process.env.PORT || 10000;
const PROJECTS_DIR = path.join(__dirname, 'temp_projects');
const FLUTTER_COMMAND = process.env.FLUTTER_COMMAND || 'flutter';

// Rest of your code remains the same...
// [Include all the remaining functions and routes from your original code]

// Ensure projects directory exists
async function ensureProjectsDir() {
    try {
        await fs.mkdir(PROJECTS_DIR, { recursive: true });
    } catch (error) {
        console.error('Error creating projects directory:', error);
    }
}

// Utility function to execute commands with timeout
async function executeCommand(command, cwd, timeout = 300000) {
    try {
        const { stdout, stderr } = await execAsync(command, { 
            cwd, 
            timeout,
            maxBuffer: 1024 * 1024 * 10 // 10MB buffer
        });
        return { success: true, stdout, stderr };
    } catch (error) {
        return { success: false, error: error.message, stderr: error.stderr };
    }
}

// Clean up old projects (run every hour)
async function cleanupOldProjects() {
    try {
        const projects = await fs.readdir(PROJECTS_DIR);
        const now = Date.now();
        const maxAge = 24 * 60 * 60 * 1000; // 24 hours

        for (const project of projects) {
            const projectPath = path.join(PROJECTS_DIR, project);
            const stats = await fs.stat(projectPath);
            
            if (now - stats.mtime.getTime() > maxAge) {
                await fs.rm(projectPath, { recursive: true, force: true });
                console.log(`Cleaned up old project: ${project}`);
            }
        }
    } catch (error) {
        console.error('Error cleaning up projects:', error);
    }
}

// Start cleanup interval
setInterval(cleanupOldProjects, 60 * 60 * 1000); // Every hour

// Create Flutter project
app.post('/api/project/create', async (req, res) => {
    try {
        const { projectId, projectName, code, dependencies } = req.body;
        
        if (!projectId || !projectName) {
            return res.status(400).json({ error: 'Project ID and name are required' });
        }

        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project already exists
        try {
            await fs.access(projectPath);
            return res.status(400).json({ error: 'Project already exists' });
        } catch (error) {
            // Project doesn't exist, continue
        }

        // Create Flutter project
        const createResult = await executeCommand(
            `${FLUTTER_COMMAND} create ${projectName} --project-name ${projectName.toLowerCase().replace(/[^a-z0-9]/g, '_')}`,
            PROJECTS_DIR
        );

        if (!createResult.success) {
            return res.status(500).json({ error: 'Failed to create Flutter project', details: createResult.error });
        }

        // Rename project directory to use projectId
        const originalPath = path.join(PROJECTS_DIR, projectName);
        await fs.rename(originalPath, projectPath);

        // Update pubspec.yaml with dependencies
        if (dependencies && dependencies.length > 0) {
            const pubspecPath = path.join(projectPath, 'pubspec.yaml');
            const pubspecContent = await fs.readFile(pubspecPath, 'utf8');
            const pubspecData = yaml.load(pubspecContent);

            // Add dependencies
            if (!pubspecData.dependencies) {
                pubspecData.dependencies = {};
            }

            dependencies.forEach(dep => {
                if (typeof dep === 'string') {
                    pubspecData.dependencies[dep] = 'any';
                } else if (dep.name && dep.version) {
                    pubspecData.dependencies[dep.name] = dep.version;
                }
            });

            // Write updated pubspec.yaml
            const updatedPubspec = yaml.dump(pubspecData, { indent: 2 });
            await fs.writeFile(pubspecPath, updatedPubspec);

            // Run flutter pub get
            await executeCommand(`${FLUTTER_COMMAND} pub get`, projectPath);
        }

        // Add provided code
        if (code) {
            await updateProjectCode(projectPath, code);
        }

        res.json({ 
            success: true, 
            message: 'Flutter project created successfully',
            projectPath: projectId
        });

    } catch (error) {
        console.error('Error creating project:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Update project code
async function updateProjectCode(projectPath, code) {
    try {
        // Expected code format:
        // {
        //   "lib/main.dart": "dart code content",
        //   "lib/screens/home.dart": "dart code content",
        //   "assets/images/logo.png": "base64_encoded_content"
        // }
        
        for (const [filePath, content] of Object.entries(code)) {
            const fullPath = path.join(projectPath, filePath);
            const dir = path.dirname(fullPath);
            
            // Ensure directory exists
            await fs.mkdir(dir, { recursive: true });
            
            // Check if content is base64 encoded (for assets)
            if (filePath.includes('assets/') && typeof content === 'string' && content.startsWith('data:')) {
                // Handle base64 encoded files
                const base64Data = content.split(',')[1];
                const buffer = Buffer.from(base64Data, 'base64');
                await fs.writeFile(fullPath, buffer);
            } else {
                // Handle text files
                await fs.writeFile(fullPath, content);
            }
        }
    } catch (error) {
        throw new Error(`Failed to update project code: ${error.message}`);
    }
}

// Get project code
app.get('/api/project/:projectId/code', async (req, res) => {
    try {
        const { projectId } = req.params;
        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project exists
        try {
            await fs.access(projectPath);
        } catch (error) {
            return res.status(404).json({ error: 'Project not found' });
        }

        const code = await getProjectCode(projectPath);
        res.json({ success: true, code });

    } catch (error) {
        console.error('Error getting project code:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Get all project files
async function getProjectCode(projectPath) {
    const code = {};
    
    async function readDirectory(dir, relativePath = '') {
        const items = await fs.readdir(dir, { withFileTypes: true });
        
        for (const item of items) {
            const itemPath = path.join(dir, item.name);
            const relativeItemPath = path.join(relativePath, item.name);
            
            // Skip certain directories and files
            if (item.name.startsWith('.') || 
                ['build', 'android', 'ios', 'web', 'windows', 'macos', 'linux'].includes(item.name)) {
                continue;
            }
            
            if (item.isDirectory()) {
                await readDirectory(itemPath, relativeItemPath);
            } else {
                // Read file content
                const content = await fs.readFile(itemPath, 'utf8');
                code[relativeItemPath.replace(/\\/g, '/')] = content;
            }
        }
    }
    
    await readDirectory(projectPath);
    return code;
}

// Update project code
app.put('/api/project/:projectId/code', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { code } = req.body;
        
        if (!code) {
            return res.status(400).json({ error: 'Code is required' });
        }

        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project exists
        try {
            await fs.access(projectPath);
        } catch (error) {
            return res.status(404).json({ error: 'Project not found' });
        }

        await updateProjectCode(projectPath, code);
        res.json({ success: true, message: 'Project code updated successfully' });

    } catch (error) {
        console.error('Error updating project code:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Run Flutter project
app.post('/api/project/:projectId/run', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { device = 'web' } = req.body;
        
        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project exists
        try {
            await fs.access(projectPath);
        } catch (error) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Run flutter pub get first
        const pubGetResult = await executeCommand(`${FLUTTER_COMMAND} pub get`, projectPath);
        if (!pubGetResult.success) {
            return res.status(500).json({ error: 'Failed to get dependencies', details: pubGetResult.error });
        }

        // Run the project
        let runCommand;
        switch (device) {
            case 'web':
                runCommand = `${FLUTTER_COMMAND} run -d web-server --web-port=0 --web-hostname=0.0.0.0`;
                break;
            case 'android':
                runCommand = `${FLUTTER_COMMAND} run -d android`;
                break;
            case 'ios':
                runCommand = `${FLUTTER_COMMAND} run -d ios`;
                break;
            default:
                runCommand = `${FLUTTER_COMMAND} run -d ${device}`;
        }

        const runResult = await executeCommand(runCommand, projectPath, 60000); // 1 minute timeout
        
        res.json({ 
            success: runResult.success, 
            output: runResult.stdout,
            error: runResult.stderr,
            message: runResult.success ? 'Project running successfully' : 'Failed to run project'
        });

    } catch (error) {
        console.error('Error running project:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Build Flutter project
app.post('/api/project/:projectId/build', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { target = 'web' } = req.body;
        
        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project exists
        try {
            await fs.access(projectPath);
        } catch (error) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Run flutter pub get first
        const pubGetResult = await executeCommand(`${FLUTTER_COMMAND} pub get`, projectPath);
        if (!pubGetResult.success) {
            return res.status(500).json({ error: 'Failed to get dependencies', details: pubGetResult.error });
        }

        // Build the project
        const buildCommand = `${FLUTTER_COMMAND} build ${target}`;
        const buildResult = await executeCommand(buildCommand, projectPath, 600000); // 10 minutes timeout
        
        res.json({ 
            success: buildResult.success, 
            output: buildResult.stdout,
            error: buildResult.stderr,
            message: buildResult.success ? 'Project built successfully' : 'Failed to build project'
        });

    } catch (error) {
        console.error('Error building project:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Save project to Supabase
app.post('/api/project/:projectId/save', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { userId, projectName } = req.body;
        
        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project exists
        try {
            await fs.access(projectPath);
        } catch (error) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Get project code
        const code = await getProjectCode(projectPath);
        
        // Get dependencies from pubspec.yaml
        const pubspecPath = path.join(projectPath, 'pubspec.yaml');
        const pubspecContent = await fs.readFile(pubspecPath, 'utf8');
        const pubspecData = yaml.load(pubspecContent);
        const dependencies = pubspecData.dependencies || {};

        // Save to Supabase
        const { data, error } = await supabase
            .from('flutter_projects')
            .upsert({
                id: projectId,
                user_id: userId,
                name: projectName,
                code: code,
                dependencies: dependencies,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'id'
            });

        if (error) {
            return res.status(500).json({ error: 'Failed to save to Supabase', details: error.message });
        }

        res.json({ success: true, message: 'Project saved to Supabase successfully' });

    } catch (error) {
        console.error('Error saving project:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Load project from Supabase
app.post('/api/project/load', async (req, res) => {
    try {
        const { projectId, userId } = req.body;
        
        if (!projectId || !userId) {
            return res.status(400).json({ error: 'Project ID and User ID are required' });
        }

        // Get project from Supabase
        const { data, error } = await supabase
            .from('flutter_projects')
            .select('*')
            .eq('id', projectId)
            .eq('user_id', userId)
            .single();

        if (error || !data) {
            return res.status(404).json({ error: 'Project not found in Supabase' });
        }

        // Create temporary Flutter project
        const dependencies = Object.keys(data.dependencies || {}).map(name => ({
            name,
            version: data.dependencies[name]
        }));

        const createResponse = await fetch(`${req.protocol}://${req.get('host')}/api/project/create`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                projectId: projectId,
                projectName: data.name,
                code: data.code,
                dependencies: dependencies
            })
        });

        if (!createResponse.ok) {
            const errorData = await createResponse.json();
            return res.status(500).json({ error: 'Failed to create temporary project', details: errorData.error });
        }

        res.json({ success: true, project: data, message: 'Project loaded successfully' });

    } catch (error) {
        console.error('Error loading project:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Delete project
app.delete('/api/project/:projectId', async (req, res) => {
    try {
        const { projectId } = req.params;
        const { saveToSupabase, userId } = req.body;
        
        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        // Check if project exists
        try {
            await fs.access(projectPath);
        } catch (error) {
            return res.status(404).json({ error: 'Project not found' });
        }

        // Save to Supabase if requested
        if (saveToSupabase && userId) {
            const saveResponse = await fetch(`${req.protocol}://${req.get('host')}/api/project/${projectId}/save`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    userId: userId,
                    projectName: projectId
                })
            });
            
            if (!saveResponse.ok) {
                console.error('Failed to save project before deletion');
            }
        }

        // Delete project directory
        await fs.rm(projectPath, { recursive: true, force: true });
        
        res.json({ success: true, message: 'Project deleted successfully' });

    } catch (error) {
        console.error('Error deleting project:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Get project status
app.get('/api/project/:projectId/status', async (req, res) => {
    try {
        const { projectId } = req.params;
        const projectPath = path.join(PROJECTS_DIR, projectId);
        
        try {
            const stats = await fs.stat(projectPath);
            res.json({ 
                success: true, 
                exists: true,
                created: stats.birthtime,
                modified: stats.mtime
            });
        } catch (error) {
            res.json({ success: true, exists: false });
        }

    } catch (error) {
        console.error('Error checking project status:', error);
        res.status(500).json({ error: 'Internal server error', details: error.message });
    }
});

// Health check endpoint
app.get('/health', (req, res) => {
    res.json({ 
        success: true, 
        message: 'Flutter Backend Server is running',
        timestamp: new Date().toISOString()
    });
});

// Error handling middleware
app.use((error, req, res, next) => {
    console.error('Unhandled error:', error);
    res.status(500).json({ error: 'Internal server error', details: error.message });
});

// Start server
app.listen(PORT, async () => {
    console.log(`Flutter Backend Server running on port ${PORT}`);
    await ensureProjectsDir();
    console.log('Projects directory ready');
});

module.exports = app;
