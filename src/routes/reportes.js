const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const { mysqlDateTimeToLocalDate } = require('../utils/datetime');
const { sanitizeReportFilters } = require('../utils/sanitize');
const ExcelJS = require('exceljs');

// Todas las rutas requieren autenticación
router.use(verifyToken);

// GET /api/reportes/kpis
// KPIs principales del periodo: ingresos, tickets, promedio ticket, ocupación aproximada, activos
router.get('/kpis', async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde, hasta } = req.query;
    const dDesde = (desde || new Date().toISOString().slice(0,10));
    const dHasta = (hasta || new Date().toISOString().slice(0,10));

    const [kpiRows] = await pool.query(
      `SELECT COALESCE(SUM(total_a_pagar),0) as ingresos, COUNT(*) as tickets
       FROM movimientos
       WHERE id_empresa = ? AND estado = 'finalizado' AND DATE(fecha_salida) BETWEEN ? AND ?`,
      [idEmpresa, dDesde, dHasta]
    );
    const ingresosMov = Number(kpiRows[0]?.ingresos || 0);
    const tickets = Number(kpiRows[0]?.tickets || 0);

    // Ingresos por pagos de mensualidades en el mismo período
    const [mensRows] = await pool.query(
      `SELECT COALESCE(SUM(monto),0) AS total FROM mensualidades_pagos WHERE id_empresa = ? AND DATE(fecha_pago) BETWEEN ? AND ?`,
      [idEmpresa, dDesde, dHasta]
    );
    const ingresosMens = Number(mensRows[0]?.total || 0);
    const ingresos = ingresosMov + ingresosMens;
    const promedioTicket = tickets > 0 ? ingresos / tickets : 0;

    // Activos actuales
    const [activosRows] = await pool.query(
      `SELECT COUNT(*) as activos
       FROM movimientos
       WHERE id_empresa = ? AND fecha_salida IS NULL`,
      [idEmpresa]
    );
    const activos = Number(activosRows[0]?.activos || 0);

    // Ocupación aproximada: ahora se calcula desde capacidades_tipo
    // Relacionado con: schema.sql tabla capacidades_tipo para capacidades dinámicas
    const [capRows] = await pool.query(
      `SELECT COALESCE(SUM(ct.capacidad_total), 0) AS capacidad
       FROM capacidades_tipo ct
       JOIN tipos_vehiculos tv ON ct.id_tipo = tv.id_tipo
       WHERE ct.id_empresa = ? AND tv.activo = TRUE`,
      [idEmpresa]
    );
    const capacidad = Number(capRows[0]?.capacidad || 0);
    const ocupacion = capacidad > 0 ? Math.min(100, Math.round((activos / capacidad) * 100)) : null;

    res.json({ success: true, data: { ingresos, ingresosMov, ingresosMens, tickets, promedioTicket, activos, ocupacion } });
  } catch (e) {
    console.error('reportes/kpis', e);
    res.status(500).json({ success: false, message: 'Error obteniendo KPIs' });
  }
});

// GET /api/reportes/ingresos-por-dia
// Serie temporal de ingresos (y opcionalmente por método)
router.get('/ingresos-por-dia', sanitizeReportFilters, async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde: dDesde, hasta: dHasta } = req.sanitized;
    const metodo = (req.query && typeof req.query.metodo === 'string') ? req.query.metodo : null;

    let rows;
    if (metodo && ['efectivo','tarjeta','QR','transferencia'].includes(metodo)) {
      // Serie por método: movimientos ajustados UNION mensualidades_pagos por método
      const [r] = await pool.query(
        `SELECT fecha, SUM(total) AS total
         FROM (
           SELECT DATE(m.fecha_salida) as fecha,
                  COALESCE(SUM(pm.monto * LEAST(1, m.total_a_pagar / NULLIF(sp.sum_monto,0))),0) as total
           FROM (
                SELECT p.id_movimiento, p.metodo_pago, SUM(p.monto) AS monto
                FROM pagos p
                WHERE p.id_empresa = ?
                GROUP BY p.id_movimiento, p.metodo_pago
           ) pm
           JOIN (
                SELECT p.id_movimiento, SUM(p.monto) AS sum_monto
                FROM pagos p
                WHERE p.id_empresa = ?
                GROUP BY p.id_movimiento
           ) sp ON sp.id_movimiento = pm.id_movimiento
           JOIN movimientos m ON m.id_movimiento = pm.id_movimiento
           WHERE m.id_empresa = ?
             AND m.estado='finalizado'
             AND pm.metodo_pago = ?
             AND DATE(m.fecha_salida) BETWEEN ? AND ?
           GROUP BY DATE(m.fecha_salida)
           UNION ALL
           SELECT DATE(mp.fecha_pago) as fecha, SUM(mp.monto) as total
           FROM mensualidades_pagos mp
           WHERE mp.id_empresa = ? AND mp.metodo_pago = ? AND DATE(mp.fecha_pago) BETWEEN ? AND ?
           GROUP BY DATE(mp.fecha_pago)
         ) x
         GROUP BY fecha
         ORDER BY fecha ASC`,
        [idEmpresa, idEmpresa, idEmpresa, metodo, dDesde, dHasta, idEmpresa, metodo, dDesde, dHasta]
      );
      rows = r;
    } else {
      // Serie total: movimientos (total_a_pagar) UNION mensualidades_pagos
      const [r] = await pool.query(
        `SELECT fecha, SUM(total) as total FROM (
           SELECT DATE(m.fecha_salida) as fecha, COALESCE(SUM(m.total_a_pagar),0) as total
           FROM movimientos m
           WHERE m.id_empresa = ? AND m.estado='finalizado' AND DATE(m.fecha_salida) BETWEEN ? AND ?
           GROUP BY DATE(m.fecha_salida)
           UNION ALL
           SELECT DATE(mp.fecha_pago) as fecha, COALESCE(SUM(mp.monto),0) as total
           FROM mensualidades_pagos mp
           WHERE mp.id_empresa = ? AND DATE(mp.fecha_pago) BETWEEN ? AND ?
           GROUP BY DATE(mp.fecha_pago)
        ) t GROUP BY fecha ORDER BY fecha ASC`,
        [idEmpresa, dDesde, dHasta, idEmpresa, dDesde, dHasta]
      );
      rows = r;
    }
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('reportes/ingresos-por-dia', e);
    res.status(500).json({ success: false, message: 'Error obteniendo ingresos por día' });
  }
});

// GET /api/reportes/ingresos-por-metodo
router.get('/ingresos-por-metodo', async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde, hasta } = req.query;
    const dDesde = (desde || new Date().toISOString().slice(0,10));
    const dHasta = (hasta || new Date().toISOString().slice(0,10));

    // Distribución por método: movimientos ajustados UNION mensualidades_pagos
    const [rows] = await pool.query(
      `SELECT metodo_pago, SUM(total) AS total
       FROM (
         SELECT pm.metodo_pago,
                COALESCE(SUM(pm.monto * LEAST(1, m.total_a_pagar / NULLIF(sp.sum_monto,0))),0) as total
         FROM (
              SELECT p.id_movimiento, p.metodo_pago, SUM(p.monto) AS monto
              FROM pagos p
              WHERE p.id_empresa = ?
              GROUP BY p.id_movimiento, p.metodo_pago
         ) pm
         JOIN (
              SELECT p.id_movimiento, SUM(p.monto) AS sum_monto
              FROM pagos p
              WHERE p.id_empresa = ?
              GROUP BY p.id_movimiento
         ) sp ON sp.id_movimiento = pm.id_movimiento
         JOIN movimientos m ON m.id_movimiento = pm.id_movimiento
         WHERE m.id_empresa = ?
           AND m.estado='finalizado'
           AND DATE(m.fecha_salida) BETWEEN ? AND ?
         GROUP BY pm.metodo_pago
         UNION ALL
         SELECT mp.metodo_pago, SUM(mp.monto) as total
         FROM mensualidades_pagos mp
         WHERE mp.id_empresa = ? AND DATE(mp.fecha_pago) BETWEEN ? AND ?
         GROUP BY mp.metodo_pago
       ) z
       GROUP BY metodo_pago`,
      [idEmpresa, idEmpresa, idEmpresa, dDesde, dHasta, idEmpresa, dDesde, dHasta]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('reportes/ingresos-por-metodo', e);
    res.status(500).json({ success: false, message: 'Error obteniendo ingresos por método' });
  }
});

// GET /api/reportes/ingresos-diarios-detalle
// Detalle de pagos del período (operaciones + mensualidades) etiquetados por tipo
router.get('/ingresos-diarios-detalle', sanitizeReportFilters, async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde: dDesde, hasta: dHasta } = req.sanitized;
    const [rows] = await pool.query(
      `SELECT * FROM (
         SELECT DATE(m.fecha_salida) as fecha,
                p.metodo_pago,
                (p.monto * LEAST(1, m.total_a_pagar / NULLIF(sp.sum_monto,0))) as monto,
                'operacion' as tipo,
                v.placa as ref1,
                m.id_movimiento as ref2
         FROM pagos p
         JOIN (
              SELECT id_movimiento, SUM(monto) as sum_monto
              FROM pagos
              WHERE id_empresa = ?
              GROUP BY id_movimiento
         ) sp ON sp.id_movimiento = p.id_movimiento
         JOIN movimientos m ON m.id_movimiento = p.id_movimiento
         JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
         WHERE p.id_empresa = ? AND m.id_empresa = ? AND m.estado='finalizado'
           AND DATE(m.fecha_salida) BETWEEN ? AND ?
         UNION ALL
         SELECT DATE(mp.fecha_pago) as fecha,
                mp.metodo_pago,
                mp.monto,
                'mensualidad' as tipo,
                v.placa as ref1,
                mp.id_mensualidad as ref2
         FROM mensualidades_pagos mp
         JOIN mensualidades mm ON mm.id_mensualidad = mp.id_mensualidad AND mm.id_empresa = mp.id_empresa
         JOIN vehiculos v ON v.id_vehiculo = mm.id_vehiculo
         WHERE mp.id_empresa = ? AND DATE(mp.fecha_pago) BETWEEN ? AND ?
       ) t
       ORDER BY fecha ASC`,
      [idEmpresa, idEmpresa, idEmpresa, dDesde, dHasta, idEmpresa, dDesde, dHasta]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('reportes/ingresos-diarios-detalle', e);
    res.status(500).json({ success: false, message: 'Error obteniendo detalle de ingresos' });
  }
});

// GET /api/reportes/movimientos
// Tabla de movimientos filtrable y paginada
router.get('/movimientos', sanitizeReportFilters, async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde: dDesde, hasta: dHasta, tipo, estado, placaLike, page, pageSize } = req.sanitized;
    const p = page;
    const ps = pageSize;
    const offset = page * pageSize;

    const where = ['m.id_empresa = ?'];
    const params = [idEmpresa];
    // Por defecto, reportes muestran FINALIZADOS por fecha_salida
    if (estado === 'activo') {
      where.push("m.estado = 'activo'");
      where.push('DATE(m.fecha_entrada) BETWEEN ? AND ?');
      params.push(dDesde, dHasta);
    } else {
      where.push("m.estado = 'finalizado'");
      where.push('DATE(m.fecha_salida) BETWEEN ? AND ?');
      params.push(dDesde, dHasta);
    }
    // Filtro por tipo: ahora usa código del tipo desde tipos_vehiculos
    if (tipo) { where.push('tv.codigo = ?'); params.push(tipo); }
    if (placaLike) { where.push('v.placa LIKE ? ESCAPE "\\"'); params.push(placaLike); }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT m.id_movimiento, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo, m.fecha_entrada, m.fecha_salida, m.total_a_pagar, m.estado
       FROM movimientos m
       JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
       JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
       ${whereSql}
       ORDER BY COALESCE(m.fecha_salida, m.fecha_entrada) DESC
       LIMIT ? OFFSET ?`,
      [...params, ps, offset]
    );

    const [countRows] = await pool.query(
      `SELECT COUNT(*) as total
       FROM movimientos m
       JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
       JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
       ${whereSql}`,
      params
    );

    res.json({ success: true, data: rows, paging: { page: p, pageSize: ps, total: countRows[0].total } });
  } catch (e) {
    console.error('reportes/movimientos', e);
    res.status(500).json({ success: false, message: 'Error listando movimientos' });
  }
});

// GET /api/reportes/movimientos-ajustados
// Igual que /movimientos pero incluye columnas de métodos de pago prorrateadas (efectivo, tarjeta, QR)
router.get('/movimientos-ajustados', sanitizeReportFilters, async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde: dDesde, hasta: dHasta, tipo, estado, placaLike, limit } = req.sanitized;
    const lim = limit;

    const where = ['m.id_empresa = ?'];
    const params = [idEmpresa];
    if (estado === 'activo') {
      where.push("m.estado = 'activo'");
      where.push('DATE(m.fecha_entrada) BETWEEN ? AND ?');
      params.push(dDesde, dHasta);
    } else {
      where.push("m.estado = 'finalizado'");
      where.push('DATE(m.fecha_salida) BETWEEN ? AND ?');
      params.push(dDesde, dHasta);
    }
    // Filtro por tipo: ahora usa código del tipo desde tipos_vehiculos
    if (tipo) { where.push('tv.codigo = ?'); params.push(tipo); }
    if (placaLike) { where.push('v.placa LIKE ? ESCAPE "\\"'); params.push(placaLike); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT m.id_movimiento, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo, m.fecha_entrada, m.fecha_salida, m.estado, m.total_a_pagar
       FROM movimientos m
       JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
       JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
       ${whereSql}
       ORDER BY COALESCE(m.fecha_salida, m.fecha_entrada) DESC
       LIMIT ?`,
      [...params, lim]
    );

    const movIds = rows.map(r=> r.id_movimiento);
    const pagosMap = new Map();
    const sumPagosMap = new Map();
    if (movIds.length) {
      const placeholders = movIds.map(()=>'?').join(',');
      const [pRows] = await pool.query(
        `SELECT id_movimiento, metodo_pago, SUM(monto) as total
         FROM pagos
         WHERE id_empresa = ? AND id_movimiento IN (${placeholders})
         GROUP BY id_movimiento, metodo_pago`,
        [idEmpresa, ...movIds]
      );
      pRows.forEach(p => {
        if (!pagosMap.has(p.id_movimiento)) pagosMap.set(p.id_movimiento, { efectivo:0, tarjeta:0, QR:0 });
        const obj = pagosMap.get(p.id_movimiento);
        if (p.metodo_pago === 'efectivo' || p.metodo_pago === 'tarjeta' || p.metodo_pago === 'QR') {
          obj[p.metodo_pago] = Number(p.total||0);
        }
        sumPagosMap.set(p.id_movimiento, (sumPagosMap.get(p.id_movimiento)||0) + Number(p.total||0));
      });
    }

    const data = rows.map(r => {
      const pagos = pagosMap.get(r.id_movimiento) || { efectivo:0, tarjeta:0, QR:0 };
      const sum = sumPagosMap.get(r.id_movimiento) || 0;
      const cap = Number(r.total_a_pagar||0);
      const scale = sum > 0 ? Math.min(1, cap / sum) : 0;
      return {
        id_movimiento: r.id_movimiento,
        placa: r.placa,
        tipo: r.tipo,
        fecha_entrada: r.fecha_entrada,
        fecha_salida: r.fecha_salida,
        estado: r.estado,
        total_a_pagar: cap,
        efectivo: Math.round((pagos.efectivo||0)*scale),
        tarjeta: Math.round((pagos.tarjeta||0)*scale),
        qr: Math.round((pagos.QR||0)*scale)
      };
    });

    res.json({ success:true, data });
  } catch (e) {
    console.error('reportes/movimientos-ajustados', e);
    res.status(500).json({ success:false, message:'Error listando movimientos ajustados' });
  }
});

// GET /api/reportes/top-placas
// Relacionado con: public/js/reportes.js función cargarTopPlacas() para mostrar top de placas
router.get('/top-placas', async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde, hasta, limit } = req.query;
    const dDesde = (desde || new Date().toISOString().slice(0,10));
    const dHasta = (hasta || new Date().toISOString().slice(0,10));
    const lim = Math.min(50, Number(limit || 10));
    // Agrupar solo por placa (no por tipo) para obtener el total de visitas y gastos por placa
    // Usar DATE() para comparar solo fechas sin horas
    const [rows] = await pool.query(
      `SELECT v.placa, 
              MAX(tv.nombre) as tipo, 
              MAX(tv.codigo) as tipo_codigo, 
              COUNT(*) as visitas, 
              COALESCE(SUM(m.total_a_pagar),0) as total
       FROM movimientos m
       JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
       JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
       WHERE m.id_empresa = ? AND m.estado='finalizado' AND DATE(m.fecha_salida) BETWEEN ? AND ?
       GROUP BY v.placa
       ORDER BY visitas DESC, total DESC
       LIMIT ?`,
      [idEmpresa, dDesde, dHasta, lim]
    );
    res.json({ success: true, data: rows });
  } catch (e) {
    console.error('reportes/top-placas', e);
    res.status(500).json({ success: false, message: 'Error obteniendo top de placas' });
  }
});

// GET /api/reportes/turnos
// Lista los cierres de turno con filtros por fecha y usuario
router.get('/turnos', sanitizeReportFilters, async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde: dDesde, hasta: dHasta } = req.sanitized;
    const usuario = (req.query && typeof req.query.usuario === 'string') ? req.query.usuario : null;

    const where = ['t.id_empresa = ?'];
    const params = [idEmpresa];
    where.push('DATE(COALESCE(t.fecha_cierre, t.fecha_apertura)) BETWEEN ? AND ?');
    params.push(dDesde, dHasta);
    if (usuario) { where.push('u.usuario_login LIKE ? ESCAPE "\\"'); params.push(require('../utils/sanitize').toSafeLike(String(usuario), { uppercase: false })); }
    const whereSql = 'WHERE ' + where.join(' AND ');

    const [rows] = await pool.query(
      `SELECT t.id_turno, t.fecha_apertura, t.fecha_cierre, t.base_inicial,
              t.total_efectivo, t.total_tarjeta, t.total_qr, t.total_general,
              t.diferencia, t.estado, u.nombre as usuario, u.usuario_login
       FROM turnos t
       JOIN usuarios u ON u.id_usuario = t.id_usuario
       ${whereSql}
       ORDER BY COALESCE(t.fecha_cierre,t.fecha_apertura) DESC`,
      params
    );
    res.json({ success:true, data: rows });
  } catch (e) {
    console.error('reportes/turnos', e);
    res.status(500).json({ success:false, message:'Error listando turnos' });
  }
});

// Exportar cierres de turno a Excel (sencillo)
router.get('/turnos/export/xlsx', sanitizeReportFilters, async (req, res) => {
  try{
    const idEmpresa = req.user.id_empresa;
    const { desde: dDesde, hasta: dHasta } = req.sanitized;
    const usuario = (req.query && typeof req.query.usuario === 'string') ? req.query.usuario : null;
    const where = ['t.id_empresa = ?','DATE(COALESCE(t.fecha_cierre,t.fecha_apertura)) BETWEEN ? AND ?'];
    const params = [idEmpresa, dDesde, dHasta];
    if (usuario) { where.push('u.usuario_login LIKE ? ESCAPE "\\"'); params.push(require('../utils/sanitize').toSafeLike(String(usuario), { uppercase: false })); }
    const whereSql = 'WHERE ' + where.join(' AND ');
    const [rows] = await pool.query(
      `SELECT t.id_turno, t.fecha_apertura, t.fecha_cierre, t.base_inicial,
              t.total_efectivo, t.total_tarjeta, t.total_qr, t.total_general,
              t.diferencia, t.estado, u.nombre as usuario, u.usuario_login
       FROM turnos t JOIN usuarios u ON u.id_usuario = t.id_usuario
       ${whereSql} ORDER BY COALESCE(t.fecha_cierre,t.fecha_apertura) DESC`,
      params
    );
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Cierres de turno');
    ws.columns = [
      { header:'#', key:'idx', width:6 },
      { header:'Apertura', key:'ap', width:20 },
      { header:'Cierre', key:'ci', width:20 },
      { header:'Usuario', key:'us', width:24 },
      { header:'Base', key:'ba', width:14 },
      { header:'Efectivo', key:'ef', width:14 },
      { header:'Tarjeta', key:'ta', width:14 },
      { header:'QR', key:'qr', width:14 },
      { header:'Total', key:'to', width:14 },
      { header:'Diferencia', key:'di', width:14 }
    ];
    rows.forEach((t,i)=> ws.addRow({ idx:i+1, ap:t.fecha_apertura, ci:t.fecha_cierre, us:t.usuario||t.usuario_login, ba:t.base_inicial, ef:t.total_efectivo, ta:t.total_tarjeta, qr:t.total_qr, to:t.total_general, di:t.diferencia }));
    ['ba','ef','ta','qr','to','di'].forEach(k=> ws.getColumn(k).numFmt = 'L #,##0.00');
    ws.getRow(1).font = { bold:true };
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition',`attachment; filename="cierres_turno_${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }catch(e){
    console.error('reportes/turnos/export/xlsx', e);
    res.status(500).json({ success:false, message:'Error exportando cierres' });
  }
});

module.exports = router;

// Exportación Excel desde backend (sin Internet)
router.get('/export/xlsx', async (req, res) => {
  try {
    const idEmpresa = req.user.id_empresa;
    const { desde, hasta, tipo, estado, placa } = req.query;
    // Usar DATE para alinear con filtros de UI y evitar TZ
    const dDesde = (desde || new Date().toISOString().slice(0,10));
    const dHasta = (hasta || new Date().toISOString().slice(0,10));

    const where = ['m.id_empresa = ?'];
    const params = [idEmpresa];
    // Para reportes: exportar finalizados por fecha de salida (coherente con KPIs y gráficos)
    if (estado === 'activo') {
      where.push("m.estado = 'activo'");
      where.push('DATE(m.fecha_entrada) BETWEEN ? AND ?');
      params.push(dDesde, dHasta);
    } else {
      where.push("m.estado = 'finalizado'");
      where.push('DATE(m.fecha_salida) BETWEEN ? AND ?');
      params.push(dDesde, dHasta);
    }
    // Filtro por tipo: ahora usa código del tipo desde tipos_vehiculos
    if (tipo) { 
      // Puede ser código (automovil, motocicleta) o id_tipo
      if (typeof tipo === 'string' && /^[a-z_]+$/.test(tipo)) {
        where.push('tv.codigo = ?'); 
        params.push(tipo);
      } else if (Number.isInteger(Number(tipo))) {
        where.push('tv.id_tipo = ?'); 
        params.push(Number(tipo));
      }
    }
    if (estado && ['activo','finalizado'].includes(estado)) { /* ya aplicado arriba */ }
    if (placa) { where.push('v.placa LIKE ?'); params.push(`%${String(placa).toUpperCase()}%`); }
    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

    const [rows] = await pool.query(
      `SELECT m.id_movimiento, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo, m.fecha_entrada, m.fecha_salida, m.estado, m.total_a_pagar
       FROM movimientos m
       JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
       JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
       ${whereSql}
       ORDER BY COALESCE(m.fecha_salida, m.fecha_entrada) DESC
       LIMIT 5000`,
      params
    );

    // Pagos por movimiento (para columnas por método y detalle)
    const movIds = rows.map(r => r.id_movimiento);
    let pagosMap = new Map(); // id_mov -> { efectivo, tarjeta, QR }
    let sumPagosMap = new Map(); // id_mov -> sum_monto
    if (movIds.length > 0) {
      const placeholders = movIds.map(() => '?').join(',');
      const pagosParams = [idEmpresa, ...movIds];
      const [pagosRows] = await pool.query(
        `SELECT id_movimiento, metodo_pago, SUM(monto) as total
         FROM pagos
         WHERE id_empresa = ? AND id_movimiento IN (${placeholders})
         GROUP BY id_movimiento, metodo_pago`,
        pagosParams
      );
      pagosRows.forEach(p => {
        if (!pagosMap.has(p.id_movimiento)) pagosMap.set(p.id_movimiento, { efectivo: 0, tarjeta: 0, QR: 0 });
        const obj = pagosMap.get(p.id_movimiento);
        const key = String(p.metodo_pago);
        if (key === 'efectivo' || key === 'tarjeta' || key === 'QR') {
          obj[key] = Number(p.total || 0);
        }
        const prev = sumPagosMap.get(p.id_movimiento) || 0;
        sumPagosMap.set(p.id_movimiento, prev + Number(p.total || 0));
      });
    }

    // KPIs del resumen basados en las filas exportadas (ingresos reales por movimientos)
    const ingresos = rows.reduce((acc, r) => acc + Number(r.total_a_pagar || 0), 0);
    const tickets = rows.length;
    const promedio = tickets > 0 ? ingresos / tickets : 0;
    const [activosRows] = await pool.query(
      `SELECT COUNT(*) as activos FROM movimientos WHERE id_empresa = ? AND fecha_salida IS NULL`,
      [idEmpresa]
    );
    const activos = Number(activosRows[0]?.activos || 0);

    const wb = new ExcelJS.Workbook();
    wb.creator = 'LKCO Estacionamiento';
    wb.created = new Date();

    // Calcular ingresos de mensualidades para el rango
    const [[mensSumRow]] = await pool.query(
      `SELECT COALESCE(SUM(monto),0) AS total FROM mensualidades_pagos WHERE id_empresa = ? AND DATE(fecha_pago) BETWEEN ? AND ?`,
      [idEmpresa, dDesde, dHasta]
    );
    const ingresosMens = Number(mensSumRow?.total || 0);
    const ingresosMov = ingresos;
    const ingresosTotal = ingresosMov + ingresosMens;

    // Hoja Resumen
    const wsResumen = wb.addWorksheet('Resumen');
    wsResumen.columns = [{ width: 28 }, { width: 28 }];
    wsResumen.addRow(['Reporte de Movimientos - LKCO Estacionamiento', '']);
    wsResumen.addRow(['Rango', `${dDesde} a ${dHasta}`]);
    wsResumen.addRow(['Ingresos (Total)', ingresosTotal]);
    wsResumen.addRow(['Ingresos Movimientos', ingresosMov]);
    wsResumen.addRow(['Ingresos Mensualidades', ingresosMens]);
    wsResumen.addRow(['Tickets', tickets]);
    wsResumen.addRow(['Promedio Ticket', promedio]);
    wsResumen.addRow(['Activos', activos]);
    wsResumen.getRow(1).font = { bold: true, size: 14 };
    wsResumen.getColumn(2).numFmt = 'L #,##0.00';
    wsResumen.getCell('B3').numFmt = 'L #,##0.00';
    wsResumen.getCell('B4').numFmt = 'L #,##0.00';
    wsResumen.getCell('B5').numFmt = 'L #,##0.00';
    wsResumen.getCell('B7').numFmt = 'L #,##0.00';

    // Estilos corporativos en encabezado
    wsResumen.getRow(1).eachCell(c => {
      c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF0D6EFD' } }; // primary
      c.font = { color:{argb:'FFFFFFFF'}, bold:true, size:14 };
    });

    // Totales por método con ajuste (mismo del donut)
    const mTotals = { efectivo: 0, tarjeta: 0, QR: 0 };
    for (const r of rows) {
      const pagos = pagosMap.get(r.id_movimiento) || { efectivo: 0, tarjeta: 0, QR: 0 };
      const sum = sumPagosMap.get(r.id_movimiento) || 0;
      const cap = Number(r.total_a_pagar || 0);
      const scale = sum > 0 ? Math.min(1, cap / sum) : 0;
      mTotals.efectivo += (pagos.efectivo || 0) * scale;
      mTotals.tarjeta  += (pagos.tarjeta  || 0) * scale;
      mTotals.QR       += (pagos.QR       || 0) * scale;
    }
    const rowBlank = wsResumen.addRow(['', '']);
    rowBlank.getCell(1).value = '';
    wsResumen.addRow(['Ingresos por método (ajustado)', '']);
    const rEf = wsResumen.addRow(['Efectivo', Math.round(mTotals.efectivo)]);
    const rTa = wsResumen.addRow(['Tarjeta', Math.round(mTotals.tarjeta)]);
    const rQr = wsResumen.addRow(['QR', Math.round(mTotals.QR)]);
    [rEf, rTa, rQr].forEach(r=>{ r.getCell(2).numFmt = 'L #,##0.00'; });
    // Colores por método
    rEf.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF198754'} }; // success
    rEf.getCell(1).font = { color:{argb:'FFFFFFFF'}, bold:true };
    rTa.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF0D6EFD'} }; // primary
    rTa.getCell(1).font = { color:{argb:'FFFFFFFF'}, bold:true };
    rQr.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFFFC107'} }; // warning
    rQr.getCell(1).font = { color:{argb:'FF000000'}, bold:true };

    // Hoja Movimientos
    const ws = wb.addWorksheet('Movimientos', { views:[{ state:'frozen', ySplit:1 }] });
    ws.columns = [
      { header: '#Mov', key: 'id_movimiento', width: 10 },
      { header: 'Placa', key: 'placa', width: 12 },
      { header: 'Tipo', key: 'tipo', width: 10 },
      { header: 'Entrada', key: 'fecha_entrada', width: 22 },
      { header: 'Salida', key: 'fecha_salida', width: 22 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Total', key: 'total_a_pagar', width: 16 },
      { header: 'Efectivo', key: 'efectivo', width: 14 },
      { header: 'Tarjeta', key: 'tarjeta', width: 14 },
      { header: 'QR', key: 'qr', width: 14 }
    ];
    rows.forEach(r => {
      const pagos = pagosMap.get(r.id_movimiento) || { efectivo: 0, tarjeta: 0, QR: 0 };
      const sum = sumPagosMap.get(r.id_movimiento) || 0;
      const cap = Number(r.total_a_pagar || 0);
      const scale = sum > 0 ? Math.min(1, cap / sum) : 0;
      const ef = Math.round((pagos.efectivo || 0) * scale);
      const ta = Math.round((pagos.tarjeta  || 0) * scale);
      const qr = Math.round((pagos.QR       || 0) * scale);
      ws.addRow({
        id_movimiento: r.id_movimiento,
        placa: r.placa,
        tipo: r.tipo,
        fecha_entrada: mysqlDateTimeToLocalDate(r.fecha_entrada),
        fecha_salida: mysqlDateTimeToLocalDate(r.fecha_salida),
        estado: String(r.estado||'').toUpperCase(),
        total_a_pagar: cap || null,
        efectivo: ef,
        tarjeta: ta,
        qr: qr
      });
    });
    // Formatos
    ws.getColumn('fecha_entrada').numFmt = 'dd/mm/yyyy hh:mm';
    ws.getColumn('fecha_salida').numFmt = 'dd/mm/yyyy hh:mm';
    ws.getColumn('total_a_pagar').numFmt = 'L #,##0.00';
    ws.getColumn('efectivo').numFmt = 'L #,##0.00';
    ws.getColumn('tarjeta').numFmt = 'L #,##0.00';
    ws.getColumn('qr').numFmt = 'L #,##0.00';
    ws.getRow(1).font = { bold: true };
    ws.getRow(1).alignment = { vertical:'middle' };
    ws.autoFilter = { from: 'A1', to: 'J1' };
    ws.eachRow({ includeEmpty:false }, (row, rowNum) => {
      if (rowNum === 1) {
        row.eachCell(c => {
          c.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FF0D6EFD'} };
          c.font = { color:{argb:'FFFFFFFF'}, bold:true };
        });
      } else if (rowNum % 2 === 0) {
        row.eachCell(c => {
          c.fill = { type:'pattern', pattern:'solid', fgColor:{argb:'FFF5F8FF'} };
        });
      }
    });

    // Fila Total real con fórmula (suma de columna Total)
    const lastDataRow = ws.rowCount + 1;
    ws.getCell(`F${lastDataRow}`).value = 'Total real';
    ws.getCell(`G${lastDataRow}`).value = { formula: `SUM(G2:G${ws.rowCount})` };
    ws.getCell(`G${lastDataRow}`).numFmt = 'L #,##0.00';

    // Hoja Mensualidades (pagos del período)
    const [mensRows] = await pool.query(
      `SELECT DATE(mp.fecha_pago) as fecha, mp.metodo_pago, mp.monto, v.placa, mp.id_mensualidad,
              mm.titular_nombre, mp.periodo_desde, mp.periodo_hasta
       FROM mensualidades_pagos mp
       JOIN mensualidades mm ON mm.id_mensualidad = mp.id_mensualidad AND mm.id_empresa = mp.id_empresa
       JOIN vehiculos v ON v.id_vehiculo = mm.id_vehiculo
       WHERE mp.id_empresa = ? AND DATE(mp.fecha_pago) BETWEEN ? AND ?
       ORDER BY mp.fecha_pago ASC`,
      [idEmpresa, dDesde, dHasta]
    );
    const wsMens = wb.addWorksheet('Mensualidades', { views: [{ state: 'frozen', ySplit: 1 }] });
    wsMens.columns = [
      { header: 'Fecha', key: 'fecha', width: 18 },
      { header: 'Método', key: 'metodo', width: 14 },
      { header: 'Monto', key: 'monto', width: 16 },
      { header: 'Placa', key: 'placa', width: 12 },
      { header: '#Mensualidad', key: 'id', width: 14 },
      { header: 'Titular', key: 'titular', width: 24 },
      { header: 'Periodo desde', key: 'desde', width: 16 },
      { header: 'Periodo hasta', key: 'hasta', width: 16 }
    ];
    mensRows.forEach(r => wsMens.addRow({
      fecha: r.fecha, metodo: r.metodo_pago, monto: r.monto, placa: r.placa,
      id: r.id_mensualidad, titular: r.titular_nombre, desde: r.periodo_desde, hasta: r.periodo_hasta
    }));
    wsMens.getColumn('fecha').numFmt = 'dd/mm/yyyy';
    wsMens.getColumn('monto').numFmt = 'L #,##0.00';
    wsMens.getRow(1).font = { bold: true };
    wsMens.getRow(1).eachCell(c => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0D6EFD' } };
      c.font = { color: { argb: 'FFFFFFFF' }, bold: true };
    });
    wsMens.autoFilter = { from: 'A1', to: 'H1' };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_movimientos_${Date.now()}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    console.error('reportes/export/xlsx', e);
    res.status(500).json({ success:false, message:'Error exportando Excel' });
  }
});


