const express = require('express');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
    console.error('JWT_SECRET no configurado o demasiado corto. Defínalo en .env.');
    process.exit(1);
}

// Determina ruta base según entorno (desarrollo vs ejecutable pkg)
// Cuando se empaqueta con pkg, process.pkg existe y el ejecutable vive en process.execPath
// Esto permite servir la carpeta "public" que se copiará junto al .exe en dist/public
const isPackaged = !!process.pkg;
const basePath = isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
const publicDir = path.join(basePath, 'public');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(publicDir));

app.get('/api/health', (req, res) => res.json({ success: true, service: 'estacionamiento-lkco', version: '2.1.0' }));

// Rutas API
app.use('/api/auth', require('./routes/auth'));
app.use('/api/vehiculos', require('./routes/vehiculos'));
app.use('/api/movimientos', require('./routes/movimientos'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/empresa', require('./routes/empresa'));
app.use('/api/tipos-vehiculos', require('./routes/tipos-vehiculos'));
app.use('/api/tarifas', require('./routes/tarifas'));
app.use('/api/pagos', require('./routes/pagos'));
app.use('/api/usuarios', require('./routes/usuarios'));
app.use('/api/reportes', require('./routes/reportes'));
app.use('/api/turnos', require('./routes/turnos'));
app.use('/api/mensualidades', require('./routes/mensualidades'));
app.use('/api/fiscal', require('./routes/fiscal'));
app.use('/api/convenios', require('./routes/convenios'));
app.use('/api/clientes', require('./routes/clientes'));

// Rutas de vistas
app.get('/', (req, res) => {
    res.sendFile(path.join(publicDir, 'index.html'));
});

app.get('/admin/dashboard', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/dashboard.html'));
});

app.get('/admin/vehiculos', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/vehiculos.html'));
});

app.get('/admin/usuarios', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/usuarios.html'));
});

app.get('/admin/mensualidades', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/mensualidades.html'));
});
app.get('/admin/mensualidades.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/mensualidades.html'));
});

app.get('/operador/dashboard', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/dashboard.html'));
});

app.get('/operador/vehiculos', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/vehiculos.html'));
});

// Rutas espejo con sufijo .html para compatibilidad con enlaces relativos
app.get('/operador/dashboard.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/dashboard.html'));
});
app.get('/operador/vehiculos.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/vehiculos.html'));
});
app.get('/operador/ingreso-salida.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/ingreso-salida.html'));
});
app.get('/operador/ingreso-salida', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/ingreso-salida.html'));
});

app.get('/admin/reportes', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/reportes.html'));
});
app.get('/admin/reportes.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/reportes.html'));
});

app.get('/admin/configuracion', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/configuracion.html'));
});
app.get('/admin/configuracion.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/configuracion.html'));
});

app.get('/admin/fiscal', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/fiscal.html'));
});
app.get('/admin/convenios', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/convenios.html'));
});

app.get('/admin/tipos-vehiculos', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/tipos-vehiculos.html'));
});
app.get('/admin/tipos-vehiculos.html', (req, res) => {
    res.sendFile(path.join(publicDir, 'admin/tipos-vehiculos.html'));
});

// Manejo de rutas no encontradas
app.use((req, res) => {
    res.status(404).sendFile(path.join(publicDir, '404.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`Servidor corriendo en el puerto ${PORT}`);
});