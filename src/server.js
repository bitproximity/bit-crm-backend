require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

const allowedOrigins = (process.env.FRONTEND_ORIGIN || '*')
  .split(',')
  .map((o) => o.trim());

app.use(
  cors({
    origin: allowedOrigins.includes('*') ? '*' : allowedOrigins,
  })
);
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.get('/health', (req, res) => res.json({ ok: true }));

app.use('/api/team', require('./routes/team'));
app.use('/api/contacts', require('./routes/contacts'));
app.use('/api/companies', require('./routes/companies'));
app.use('/api/pipelines', require('./routes/pipelines'));
app.use('/api/deals', require('./routes/deals'));
app.use('/api/projects', require('./routes/projects'));
app.use('/api/tasks', require('./routes/tasks'));
app.use('/api/tags', require('./routes/tags'));
app.use('/api/activities', require('./routes/activities'));
app.use('/api/templates', require('./routes/templates'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/custom-fields', require('./routes/customFields'));
app.use('/api/exchange-rates', require('./routes/exchangeRates'));
app.use('/api/gmail', require('./routes/gmail'));
app.use('/api/products', require('./routes/products'));
app.use('/api/forecast', require('./routes/forecast'));
app.use('/api/metrics', require('./routes/metrics'));
app.use('/api/insights', require('./routes/insights'));
app.use('/api/calcom', require('./routes/calcom'));
app.use('/api/mcp-keys', require('./routes/mcpKeys'));
app.use('/api/spaces', require('./routes/spaces'));
app.use('/api/documents', require('./routes/documents'));

// Manejo de errores no capturados
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bit CRM backend corriendo en el puerto ${PORT}`);
});
