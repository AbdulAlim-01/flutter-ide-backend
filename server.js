const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 4000;

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const PROJECTS_ROOT = "/projects"; // Can be adjusted

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

app.use(cors());
app.use(bodyParser.json());

// 🔐 Middleware: Validate user token
async function verifyToken(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.split(' ')[1];
  if (!token) return res.status(401).send('Missing token');

  const { data: { user }, error } = await supabase.auth.getUser(token);
 if (error || !user) return res.status(401).send((error && error.message) || 'Unauthorized');


  req.user = user;
  next();
}

app.get('/', (req, res) => {
  res.send('✅ Flutter IDE backend is running.');
});

// PLACE THIS BELOW your other routes in server.js
app.get('/tree', verifyToken, (req, res) => {
  const rel = req.query.path || '';
  // base it off the logged‑in user’s folder
  const root = path.join(PROJECTS_ROOT, req.user.id, rel);

  if (!fs.existsSync(root)) {
    return res.status(404).send('Not found');
  }

  const items = fs.readdirSync(root).map(name => {
    const full = path.join(root, name);
    return {
      name,
      isDirectory: fs.statSync(full).isDirectory(),
    };
  });

  res.json({ path: rel, items });
});


// 📁 Create Project
app.post('/create', verifyToken, (req, res) => {
  const { projectName } = req.body;
  const uid = req.user.id;
  const dir = path.join(PROJECTS_ROOT, uid, projectName);
  fs.mkdirSync(dir, { recursive: true });

  const proc = spawn('flutter', ['create', '--project-name', projectName, dir]);
  proc.on('close', code => {
    if (code !== 0) return res.status(500).send('flutter create failed');
    res.json({ status: 'created' });
  });
});

// 📁 List Projects
app.get('/list', verifyToken, (req, res) => {
  const userDir = path.join(PROJECTS_ROOT, req.user.id);
  if (!fs.existsSync(userDir)) return res.json({ projects: [] });

  const projects = fs.readdirSync(userDir)
    .filter(name => fs.statSync(path.join(userDir, name)).isDirectory());

  res.json({ projects });
});

// 📄 Read File
app.get('/file', verifyToken, (req, res) => {
  const { project, path: rel } = req.query;
  const filePath = path.join(PROJECTS_ROOT, req.user.id, project, rel);
  if (!fs.existsSync(filePath)) return res.status(404).send('Not found');
  res.send(fs.readFileSync(filePath, 'utf8'));
});

// 💾 Save File
app.post('/save', verifyToken, (req, res) => {
  const { project, path: rel, content } = req.body;
  const filePath = path.join(PROJECTS_ROOT, req.user.id, project, rel);
  fs.writeFileSync(filePath, content, 'utf8');
  res.json({ status: 'saved' });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
