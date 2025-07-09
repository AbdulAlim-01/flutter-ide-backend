const express = require('express');
const fs = require('fs').promises;
const path = require('path');
const { spawn, exec } = require('child_process');
const cors = require('cors');
const yaml = require('js-yaml');
const { createProxyMiddleware } = require('http-proxy-middleware'); // Add this import

const app = express();
const PORT = process.env.PORT || 3000;
const PROJECTS_DIR = path.join(__dirname, 'flutter_projects');

// Store running processes
const runningProjects = new Map();

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Utility functions remain unchanged until stopProject
const ensureProjectsDir = async () => {
  try {
    await fs.access(PROJECTS_DIR);
  } catch {
    await fs.mkdir(PROJECTS_DIR, { recursive: true });
  }
};

const projectExists = async (projectName) => {
  try {
    await fs.access(path.join(PROJECTS_DIR, projectName));
    return true;
  } catch {
    return false;
  }
};

const execCommand = (command, cwd = PROJECTS_DIR) => {
  return new Promise((resolve, reject) => {
    exec(command, { cwd }, (error, stdout, stderr) => {
      if (error) {
        reject({ error: error.message, stderr });
        return;
      }
      resolve({ stdout, stderr });
    });
  });
};

const readFileContent = async (filePath) => {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    return content;
  } catch (error) {
    throw new Error(`Failed to read file: ${error.message}`);
  }
};

const writeFileContent = async (filePath, content) => {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, 'utf8');
  } catch (error) {
    throw new Error(`Failed to write file: ${error.message}`);
  }
};

const deleteDirectory = async (dirPath) => {
  try {
    await fs.rm(dirPath, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`Failed to delete directory: ${error.message}`);
  }
};

const parseNewCodeFormat = (codeString) => {
  const files = [];
  let dependencies = [];
  
  const fileSections = codeString.split(/\/\/\s*[Ff]ile\s*:\s*/);
  
  for (let i = 1; i < fileSections.length; i++) {
    const section = fileSections[i];
    const lines = section.split('\n');
    const filename = lines[0].trim();
    const code = lines.slice(1).join('\n').trim();
    
    if (filename && code) {
      files.push({
        file: filename,
        code: code
      });
    }
  }
  
  const dependencyMatch = codeString.match(/\/\/\s*[Dd]ependencies\s*:\s*\[(.*?)\]/);
  if (dependencyMatch) {
    const depsString = dependencyMatch[1];
    dependencies = depsString.split(',').map(dep => dep.trim()).filter(dep => dep);
  }
  
  return { files, dependencies };
};

const updatePubspecWithDependencies = async (pubspecPath, newDependencies) => {
  try {
    const existingPubspec = await readFileContent(pubspecPath);
    const pubspecData = yaml.load(existingPubspec);
    
    if (newDependencies.length > 0) {
      if (!pubspecData.dependencies) {
        pubspecData.dependencies = {};
      }
      newDependencies.forEach(dep => {
        if (!pubspecData.dependencies[dep]) {
          pubspecData.dependencies[dep] = '^latest';
        }
      });
    }
    
    const updatedPubspec = yaml.dump(pubspecData, { 
      indent: 2,
      lineWidth: -1 
    });
    await writeFileContent(pubspecPath, updatedPubspec);
    
    return true;
  } catch (error) {
    throw new Error(`Failed to update pubspec.yaml: ${error.message}`);
  }
};

const checkFlutterInstallation = async () => {
  try {
    const result = await execCommand('flutter --version');
    return { installed: true, version: result.stdout };
  } catch (error) {
    return { installed: false, error: error.message };
  }
};

const findAvailablePort = async (startPort = 8080) => {
  const net = require('net');
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(startPort, () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', () => {
      resolve(findAvailablePort(startPort + 1));
    });
  });
};

const stopProject = async (projectName) => {
  if (runningProjects.has(projectName)) {
    const processInfo = runningProjects.get(projectName);
    try {
      process.kill(processInfo.pid, 'SIGTERM');
      // Remove the project-specific router from the stack
      app._router.stack = app._router.stack.filter(layer => layer.handle !== processInfo.router);
      runningProjects.delete(projectName);
      return true;
    } catch (error) {
      console.error(`Failed to stop project ${projectName}:`, error.message);
      return false;
    }
  }
  return false;
};

// Routes remain unchanged until /run
app.post('/create', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const projectName = name.trim();
    if (!/^[a-z][a-z0-9_]*$/.test(projectName)) {
      return res.status(400).json({ 
        error: 'Invalid project name. Use lowercase letters, numbers, and underscores only. Must start with a letter.' 
      });
    }
    await ensureProjectsDir();
    if (await projectExists(projectName)) {
      return res.status(400).json({ error: 'Project already exists' });
    }
    const result = await execCommand(`flutter create ${projectName}`);
    res.json({
      success: true,
      message: `Flutter project '${projectName}' created successfully`,
      output: result.stdout
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to create project',
      details: error.error || error.message,
      stderr: error.stderr
    });
  }
});

app.post('/update', async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) {
      return res.status(400).json({ error: 'Project name and code are required' });
    }
    const projectName = name.trim();
    const projectPath = path.join(PROJECTS_DIR, projectName);
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const { files, dependencies } = parseNewCodeFormat(code);
    if (files.length === 0) {
      return res.status(400).json({ error: 'No valid files found in the provided code format' });
    }
    const libPath = path.join(projectPath, 'lib');
    const pubspecPath = path.join(projectPath, 'pubspec.yaml');
    if (dependencies.length > 0) {
      await updatePubspecWithDependencies(pubspecPath, dependencies);
    }
    const processedFiles = [];
    for (const fileObj of files) {
      const { file, code } = fileObj;
      const fileName = file.endsWith('.dart') ? file : `${file}.dart`;
      const filePath = path.join(libPath, fileName);
      await writeFileContent(filePath, code);
      processedFiles.push(fileName);
    }
    if (dependencies.length > 0) {
      await execCommand(`flutter pub get`, projectPath);
    }
    res.json({
      success: true,
      message: `Project '${projectName}' updated successfully`,
      filesProcessed: processedFiles,
      dependenciesAdded: dependencies,
      totalFiles: processedFiles.length
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to update project',
      details: error.message
    });
  }
});

app.get('/open/:name', async (req, res) => {
  try {
    const projectName = req.params.name.trim();
    const projectPath = path.join(PROJECTS_DIR, projectName);
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const libPath = path.join(projectPath, 'lib');
    const pubspecPath = path.join(projectPath, 'pubspec.yaml');
    const libFiles = [];
    try {
      const files = await fs.readdir(libPath);
      for (const file of files) {
        if (file.endsWith('.dart')) {
          const filePath = path.join(libPath, file);
          const content = await readFileContent(filePath);
          libFiles.push({
            file: file,
            code: content
          });
        }
      }
    } catch (error) {
      return res.status(500).json({ error: 'Failed to read lib folder' });
    }
    let pubspecContent;
    try {
      pubspecContent = await readFileContent(pubspecPath);
    } catch (error) {
      return res.status(500).json({ error: 'Failed to read pubspec.yaml' });
    }
    res.json({
      success: true,
      project: projectName,
      libFiles: libFiles,
      pubspec: pubspecContent
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to open project',
      details: error.message
    });
  }
});

app.post('/run', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const projectName = name.trim();
    const projectPath = path.join(PROJECTS_DIR, projectName);
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const flutterCheck = await checkFlutterInstallation();
    if (!flutterCheck.installed) {
      return res.status(500).json({
        error: 'Flutter is not installed or not in PATH',
        details: flutterCheck.error,
        solution: 'Please install Flutter SDK and add it to your system PATH. Visit https://flutter.dev/docs/get-started/install'
      });
    }
    await stopProject(projectName);
    const port = await findAvailablePort();

    // Define route handlers
    const previewHandler = (req, res) => {
      const html = `
        <!DOCTYPE html>
        <html>
        <head>
          <title>Flutter Project: ${projectName}</title>
        </head>
        <body>
          <iframe src="/preview/${projectName}/app" style="width:100%; height:100vh; border:none;"></iframe>
          <script>
            setInterval(() => {
              fetch('/preview/${projectName}/ping', { method: 'POST' });
            }, 30000);
          </script>
        </body>
        </html>
      `;
      res.send(html);
    };

    const pingHandler = (req, res) => {
      if (runningProjects.has(projectName)) {
        runningProjects.get(projectName).lastPing = Date.now();
        res.sendStatus(200);
      } else {
        res.sendStatus(404);
      }
    };

    // Create a router for this project
    const projectRouter = express.Router();
    projectRouter.get('/', previewHandler);
    projectRouter.post('/ping', pingHandler);
    projectRouter.use('/app', createProxyMiddleware({
      target: `http://localhost:${port}`,
      changeOrigin: true,
      pathRewrite: (path) => path.replace(`/preview/${projectName}/app`, '')
    }));

    // Mount the router
    app.use(`/preview/${projectName}`, projectRouter);

    // Start Flutter web server
    const flutterProcess = spawn('flutter', ['run', '-d', 'web-server', '--web-port', port.toString()], {
      cwd: projectPath,
      stdio: 'pipe',
      shell: process.platform === 'win32'
    });

    runningProjects.set(projectName, {
      pid: flutterProcess.pid,
      port: port,
      router: projectRouter, // Store the router for cleanup
      lastPing: Date.now(),
      startTime: new Date(),
      status: 'starting'
    });

    res.json({
      success: true,
      status: 'loading',
      message: `Starting Flutter project '${projectName}'...`,
      preview_url: `${req.protocol}://${req.get('host')}/preview/${projectName}`,
      port: port,
      flutter_version: flutterCheck.version.split('\n')[0]
    });

    flutterProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log(`[${projectName}] STDOUT:`, output);
      if (output.includes('Flutter run key commands') || 
          output.includes('lib/main.dart') || 
          output.includes('Web server started') ||
          output.includes('Running on')) {
        if (runningProjects.has(projectName)) {
          const processInfo = runningProjects.get(projectName);
          processInfo.status = 'running';
          runningProjects.set(projectName, processInfo);
        }
      }
    });

    flutterProcess.stderr.on('data', (data) => {
      const errorOutput = data.toString();
      console.error(`[${projectName}] STDERR:`, errorOutput);
      if (runningProjects.has(projectName)) {
        const processInfo = runningProjects.get(projectName);
        processInfo.status = 'error';
        processInfo.error = errorOutput;
        runningProjects.set(projectName, processInfo);
      }
    });

    flutterProcess.on('close', (code) => {
      console.log(`[${projectName}] Process exited with code ${code}`);
      stopProject(projectName);
    });

    flutterProcess.on('error', (error) => {
      console.error(`[${projectName}] Process error:`, error);
      if (runningProjects.has(projectName)) {
        const processInfo = runningProjects.get(projectName);
        processInfo.status = 'error';
        processInfo.error = error.message;
        runningProjects.set(projectName, processInfo);
      } else {
        stopProject(projectName);
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to run project',
      details: error.message
    });
  }
});

// Remaining routes remain unchanged
app.get('/status/:name', async (req, res) => {
  try {
    const projectName = req.params.name.trim();
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const processInfo = runningProjects.get(projectName);
    if (!processInfo) {
      return res.json({
        success: true,
        status: 'stopped',
        message: 'Project is not running'
      });
    }
    res.json({
      success: true,
      status: processInfo.status,
      port: processInfo.port,
      preview_url: `http://localhost:${processInfo.port}`, // Note: This could be updated for production
      startTime: processInfo.startTime,
      pid: processInfo.pid,
      error: processInfo.error || null
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get project status',
      details: error.message
    });
  }
});

app.post('/stop', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const projectName = name.trim();
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    const stopped = await stopProject(projectName);
    res.json({
      success: true,
      message: stopped ? 
        `Project '${projectName}' stopped successfully` : 
        `Project '${projectName}' was not running`,
      stopped: stopped
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to stop project',
      details: error.message
    });
  }
});

app.post('/build', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Project name is required' });
    }
    const projectName = name.trim();
    const projectPath = path.join(PROJECTS_DIR, projectName);
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await stopProject(projectName);
    const buildResult = await execCommand(`flutter build apk --release`, projectPath);
    const apkPath = path.join(projectPath, 'build/app/outputs/flutter-apk/app-release.apk');
    let apkExists = false;
    try {
      await fs.access(apkPath);
      apkExists = true;
    } catch {
      apkExists = false;
    }
    res.json({
      success: true,
      message: `APK build completed for project '${projectName}'`,
      apkPath: apkExists ? apkPath : null,
      apkExists: apkExists,
      buildOutput: buildResult.stdout,
      downloadUrl: apkExists ? `/download/${projectName}/apk` : null
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to build project',
      details: error.error || error.message,
      stderr: error.stderr
    });
  }
});

app.get('/download/:name/apk', async (req, res) => {
  try {
    const projectName = req.params.name.trim();
    const projectPath = path.join(PROJECTS_DIR, projectName);
    const apkPath = path.join(projectPath, 'build/app/outputs/flutter-apk/app-release.apk');
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    try {
      await fs.access(apkPath);
      res.download(apkPath, `${projectName}.apk`);
    } catch {
      res.status(404).json({ error: 'APK not found. Build the project first.' });
    }
  } catch (error) {
    res.status(500).json({
      error: 'Failed to download APK',
      details: error.message
    });
  }
});

app.delete('/delete/:name', async (req, res) => {
  try {
    const projectName = req.params.name.trim();
    const projectPath = path.join(PROJECTS_DIR, projectName);
    if (!(await projectExists(projectName))) {
      return res.status(404).json({ error: 'Project not found' });
    }
    await stopProject(projectName);
    await deleteDirectory(projectPath);
    res.json({
      success: true,
      message: `Project '${projectName}' deleted successfully`
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to delete project',
      details: error.message
    });
  }
});

app.get('/projects', async (req, res) => {
  try {
    await ensureProjectsDir();
    const projects = await fs.readdir(PROJECTS_DIR);
    const projectList = [];
    for (const project of projects) {
      const projectPath = path.join(PROJECTS_DIR, project);
      const stats = await fs.stat(projectPath);
      if (stats.isDirectory()) {
        const processInfo = runningProjects.get(project);
        projectList.push({
          name: project,
          created: stats.birthtime,
          modified: stats.mtime,
          running: !!processInfo,
          status: processInfo ? processInfo.status : 'stopped',
          port: processInfo ? processInfo.port : null
        });
      }
    }
    res.json({
      success: true,
      projects: projectList
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to list projects',
      details: error.message
    });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    flutter: 'Flutter SDK required for full functionality',
    runningProjects: Array.from(runningProjects.keys())
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    error: 'Internal server error',
    details: err.message
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Endpoint not found',
    availableEndpoints: [
      'POST /create',
      'POST /update',
      'GET /open/:name',
      'POST /run',
      'GET /status/:name',
      'POST /stop',
      'POST /build',
      'GET /download/:name/apk',
      'DELETE /delete/:name',
      'GET /projects',
      'GET /health'
    ]
  });
});

// Periodic check for inactive projects
setInterval(() => {
  const now = Date.now();
  for (const [projectName, processInfo] of runningProjects) {
    if (now - processInfo.lastPing > 60000) { // 60 seconds
      console.log(`Stopping inactive project: ${projectName}`);
      stopProject(projectName);
    }
  }
}, 30000);

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('Received SIGTERM, shutting down gracefully...');
  for (const [projectName] of runningProjects) {
    await stopProject(projectName);
  }
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('Received SIGINT, shutting down gracefully...');
  for (const [projectName] of runningProjects) {
    await stopProject(projectName);
  }
  process.exit(0);
});

// Start server
app.listen(PORT, () => {
  console.log(`Flutter Project Management Server running on port ${PORT}`);
  console.log(`Available endpoints:`);
  console.log(`- POST /create - Create new Flutter project`);
  console.log(`- POST /update - Update project code (Enhanced parsing)`);
  console.log(`- GET /open/:name - Get project code`);
  console.log(`- POST /run - Run project under /preview/$projectname`);
  console.log(`- GET /status/:name - Get project running status`);
  console.log(`- POST /stop - Stop running project`);
  console.log(`- POST /build - Build APK`);
  console.log(`- GET /download/:name/apk - Download APK`);
  console.log(`- DELETE /delete/:name - Delete project`);
  console.log(`- GET /projects - List all projects`);
  console.log(`- GET /health - Health check`);
});

module.exports = app;
