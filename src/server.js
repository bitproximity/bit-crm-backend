require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

app.use(cors({ origin: process.env.FRONTEND_ORIGIN || '*' }));
app.use(express.json());

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

// Manejo de errores no capturados
app.use((err, req, res, next) => {
  console.error('Error no manejado:', err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Bit CRM backend corriendo en el puerto ${PORT}`);
});
