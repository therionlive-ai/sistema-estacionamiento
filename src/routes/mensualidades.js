const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');

router.use(verifyToken);

// Listar mensualidades con estado, placa y titular (paginado)
router.get('/', async (req, res) => {
    try {
        const { q = '', estado = '', page = 1, pageSize = 20 } = req.query;
        const idEmpresa = req.user.id_empresa;
        const limit = Math.min(parseInt(pageSize) || 20, 100);
        const offset = Math.max(((parseInt(page) || 1) - 1) * limit, 0);

        const where = ['m.id_empresa = ?'];
        const params = [idEmpresa];
        if (estado) { where.push('m.estado = ?'); params.push(estado); }
        if (q) {
            where.push('(v.placa LIKE ? OR m.titular_nombre LIKE ? OR m.titular_documento LIKE ?)');
            params.push(`%${q}%`, `%${q}%`, `%${q}%`);
        }

        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre AS tipo, tv.codigo AS tipo_codigo, v.id_tipo, p.last_paid_until
             FROM mensualidades m
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
             LEFT JOIN (
                 SELECT id_mensualidad, MAX(periodo_hasta) AS last_paid_until
                 FROM mensualidades_pagos
                 WHERE id_empresa = ?
                 GROUP BY id_mensualidad
             ) p ON p.id_mensualidad = m.id_mensualidad
             WHERE ${where.join(' AND ')}
             ORDER BY m.fecha_creacion DESC
             LIMIT ? OFFSET ?`,
            [idEmpresa, ...params, limit, offset]
        );

        const [[{ total }]] = await pool.query(
            `SELECT COUNT(*) total
             FROM mensualidades m
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
             WHERE ${where.join(' AND ')}`,
            params
        );

        const withComputed = rows.map(row => {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const fechaInicio = row.fecha_inicio ? new Date(row.fecha_inicio) : null;
            const fechaFin = row.fecha_fin ? new Date(row.fecha_fin) : null;
            const lastPaidUntil = row.last_paid_until ? new Date(row.last_paid_until) : null;

            let nextStart = fechaInicio ? new Date(fechaInicio) : null;
            if (lastPaidUntil) {
                const ns = new Date(lastPaidUntil);
                ns.setDate(ns.getDate() + 1);
                nextStart = ns;
            }

            let overduePayments = 0;
            let dueStatus = 'al_dia';
            let nextPaymentDate = nextStart ? nextStart.toISOString().slice(0, 10) : null;
            let daysToNext = null;

            const isInactive = (row.estado === 'cancelada') || (fechaFin && today > fechaFin);
            if (isInactive || !nextStart) {
                dueStatus = 'inactivo';
            } else {
                const compareDate = new Date(nextStart);
                compareDate.setHours(0, 0, 0, 0);
                if (today >= compareDate) {
                    const monthsDiff = (b, a) => {
                        let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
                        if (b.getDate() >= a.getDate()) m += 1;
                        return m;
                    };
                    overduePayments = Math.max(1, monthsDiff(today, compareDate));
                    dueStatus = 'vencido';
                } else {
                    const msPerDay = 86400000;
                    daysToNext = Math.ceil((compareDate - today) / msPerDay);
                    dueStatus = daysToNext <= 5 ? 'proximo' : 'al_dia';
                }
            }

            return {
                ...row,
                next_payment_date: nextPaymentDate,
                overdue_payments: overduePayments,
                due_status: dueStatus,
                days_to_next: daysToNext
            };
        });

        res.json({ success: true, data: withComputed, total });
    } catch (e) {
        console.error('Mensualidades GET:', e);
        res.status(500).json({ success: false, message: 'Error al listar mensualidades' });
    }
});

// Crear mensualidad (si la placa no existe en empresa, crear vehículo con id_tipo)
router.post('/', async (req, res) => {
    const idEmpresa = req.user.id_empresa;
    let {
        placa,
        id_tipo,
        titular_nombre,
        titular_documento,
        titular_telefono,
        titular_email,
        valor_mensual,
        fecha_inicio,
        auto_renovar = true,
        observaciones = ''
    } = req.body;

    try {
        if (!placa || !titular_nombre || !valor_mensual || !fecha_inicio) {
            return res.status(400).json({ success: false, message: 'Faltan datos obligatorios' });
        }

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            if (id_tipo) {
                const [tipoRows] = await conn.query(
                    `SELECT id_tipo FROM tipos_vehiculos
                     WHERE id_tipo = ? AND id_empresa = ? AND activo = TRUE
                       AND codigo IN ('automovil','motocicleta')`,
                    [parseInt(id_tipo), idEmpresa]
                );
                if (!tipoRows.length) throw new Error('Tipo de vehículo no válido para este establecimiento');
            }

            const [veh] = await conn.query(
                'SELECT id_vehiculo FROM vehiculos WHERE placa = ? AND id_empresa = ?',
                [placa.toUpperCase(), idEmpresa]
            );
            let idVehiculo;
            if (veh.length) {
                idVehiculo = veh[0].id_vehiculo;
                if (id_tipo) {
                    const [vehTipo] = await conn.query('SELECT id_tipo FROM vehiculos WHERE id_vehiculo = ? AND id_empresa = ?', [idVehiculo, idEmpresa]);
                    if (vehTipo.length && Number(vehTipo[0].id_tipo) !== Number(id_tipo)) {
                        throw new Error('El tipo seleccionado no coincide con el vehículo registrado');
                    }
                }
            } else {
                if (!id_tipo) throw new Error('Tipo de vehículo requerido para crear el vehículo');
                const [insVeh] = await conn.query(
                    `INSERT INTO vehiculos (id_empresa, placa, id_tipo, color, modelo) VALUES (?, ?, ?, '', '')`,
                    [idEmpresa, placa.toUpperCase(), parseInt(id_tipo)]
                );
                idVehiculo = insVeh.insertId;
            }

            const [ins] = await conn.query(
                `INSERT INTO mensualidades (
                    id_empresa, id_vehiculo, titular_nombre, titular_documento, titular_telefono, titular_email,
                    valor_mensual, fecha_inicio, fecha_fin, auto_renovar, estado, observaciones
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 'activa', ?)`,
                [
                    idEmpresa, idVehiculo, titular_nombre,
                    titular_documento || null, titular_telefono || null, titular_email || null,
                    Number(valor_mensual), fecha_inicio, auto_renovar ? 1 : 0, observaciones
                ]
            );

            await conn.commit();
            res.status(201).json({ success: true, id_mensualidad: ins.insertId, message: 'Mensualidad creada' });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('Mensualidades POST:', e);
        res.status(500).json({ success: false, message: e.message || 'Error al crear mensualidad' });
    }
});

// Actualizar mensualidad
router.put('/:id', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);
        const {
            placa,
            id_tipo,
            titular_nombre,
            titular_documento,
            titular_telefono,
            titular_email,
            valor_mensual,
            fecha_inicio,
            fecha_fin,
            auto_renovar,
            estado,
            observaciones
        } = req.body;

        const conn = await pool.getConnection();
        try {
            await conn.beginTransaction();

            if (id_tipo) {
                const [tipoRows] = await conn.query(
                    `SELECT id_tipo FROM tipos_vehiculos
                     WHERE id_tipo = ? AND id_empresa = ? AND activo = TRUE
                       AND codigo IN ('automovil','motocicleta')`,
                    [parseInt(id_tipo), idEmpresa]
                );
                if (!tipoRows.length) throw new Error('Tipo de vehículo no válido para este establecimiento');
            }

            const [currRows] = await conn.query(
                `SELECT m.id_mensualidad, m.id_vehiculo, v.placa AS placa_actual
                 FROM mensualidades m
                 JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
                 WHERE m.id_mensualidad = ? AND m.id_empresa = ?`,
                [id, idEmpresa]
            );
            if (!currRows.length) {
                await conn.rollback();
                conn.release();
                return res.status(404).json({ success: false, message: 'Mensualidad no encontrada' });
            }
            let idVehiculo = currRows[0].id_vehiculo;
            const placaActual = (currRows[0].placa_actual || '').toUpperCase();

            if (placa && placa.toUpperCase() !== placaActual) {
                const [vehExist] = await conn.query(
                    `SELECT id_vehiculo FROM vehiculos WHERE placa = ? AND id_empresa = ?`,
                    [placa.toUpperCase(), idEmpresa]
                );
                if (vehExist.length) {
                    idVehiculo = vehExist[0].id_vehiculo;
                } else {
                    if (!id_tipo) throw new Error('Tipo de vehículo requerido para crear el vehículo con la nueva placa');
                    const [insVeh] = await conn.query(
                        `INSERT INTO vehiculos (id_empresa, placa, id_tipo, color, modelo) VALUES (?, ?, ?, '', '')`,
                        [idEmpresa, placa.toUpperCase(), parseInt(id_tipo)]
                    );
                    idVehiculo = insVeh.insertId;
                }
            }

            const [r] = await conn.query(
                `UPDATE mensualidades SET
                    id_vehiculo = ?,
                    titular_nombre = COALESCE(?, titular_nombre),
                    titular_documento = ?,
                    titular_telefono = ?,
                    titular_email = ?,
                    valor_mensual = COALESCE(?, valor_mensual),
                    fecha_inicio = COALESCE(?, fecha_inicio),
                    fecha_fin = COALESCE(?, fecha_fin),
                    auto_renovar = COALESCE(?, auto_renovar),
                    estado = COALESCE(?, estado),
                    observaciones = COALESCE(?, observaciones)
                 WHERE id_mensualidad = ? AND id_empresa = ?`,
                [
                    idVehiculo,
                    titular_nombre || null,
                    titular_documento || null,
                    titular_telefono || null,
                    titular_email || null,
                    (valor_mensual !== undefined ? Number(valor_mensual) : null),
                    fecha_inicio || null,
                    fecha_fin || null,
                    (auto_renovar === undefined ? null : (auto_renovar ? 1 : 0)),
                    estado || null,
                    observaciones || null,
                    id, idEmpresa
                ]
            );

            await conn.commit();
            res.json({ success: true, message: r.affectedRows ? 'Mensualidad actualizada' : 'Sin cambios' });
        } catch (e) {
            await conn.rollback();
            throw e;
        } finally {
            conn.release();
        }
    } catch (e) {
        console.error('Mensualidades PUT:', e);
        res.status(500).json({ success: false, message: e.message || 'Error al actualizar mensualidad' });
    }
});

// Detalle de una mensualidad
router.get('/:id', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);
        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre AS tipo, tv.codigo AS tipo_codigo, v.id_tipo
             FROM mensualidades m
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
             WHERE m.id_mensualidad = ? AND m.id_empresa = ?`,
            [id, idEmpresa]
        );
        if (!rows.length) return res.status(404).json({ success: false, message: 'Mensualidad no encontrada' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error('Mensualidades detail GET:', e);
        res.status(500).json({ success: false, message: 'Error al obtener mensualidad' });
    }
});

// Obtener pagos de una mensualidad
router.get('/:id/pagos', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const idMens = parseInt(req.params.id);
        const [rows] = await pool.query(
            `SELECT * FROM mensualidades_pagos WHERE id_empresa = ? AND id_mensualidad = ? ORDER BY fecha_pago DESC`,
            [idEmpresa, idMens]
        );
        res.json({ success: true, data: rows });
    } catch (e) {
        console.error('Mensualidades pagos GET:', e);
        res.status(500).json({ success: false, message: 'Error al obtener pagos' });
    }
});

// Registrar pago de mensualidad por periodo
router.post('/:id/pagos', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const idMens = parseInt(req.params.id);
        const { periodo_desde, periodo_hasta, metodo_pago = 'efectivo', monto, referencia_pago = null } = req.body;

        if (!periodo_desde || !periodo_hasta || !monto) {
            return res.status(400).json({ success: false, message: 'Datos de pago incompletos' });
        }

        const [own] = await pool.query(
            `SELECT id_mensualidad FROM mensualidades WHERE id_mensualidad = ? AND id_empresa = ?`,
            [idMens, idEmpresa]
        );
        if (!own.length) return res.status(404).json({ success: false, message: 'Mensualidad no encontrada' });

        const [turnoRows] = await pool.query(
            `SELECT id_turno FROM turnos WHERE id_empresa = ? AND id_usuario = ? AND estado = 'abierto' LIMIT 1`,
            [idEmpresa, req.user.id]
        );
        if (!turnoRows.length) {
            return res.status(409).json({ success: false, message: 'Debe abrir un turno antes de registrar pagos de mensualidad' });
        }

        await pool.query(
            `INSERT INTO mensualidades_pagos (
                id_empresa, id_mensualidad, periodo_desde, periodo_hasta, metodo_pago, monto, referencia_pago, id_usuario
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [idEmpresa, idMens, periodo_desde, periodo_hasta, metodo_pago, Number(monto), referencia_pago, req.user.id]
        );

        res.status(201).json({ success: true, message: 'Pago registrado' });
    } catch (e) {
        console.error('Mensualidades pagos POST:', e);
        res.status(500).json({ success: false, message: 'Error al registrar pago' });
    }
});

// Sugerencia de pago: próximo periodo y monto por defecto
router.get('/:id/sugerencia-pago', async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const id = parseInt(req.params.id);

        const [[mens]] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre AS tipo, v.id_tipo, (
                SELECT MAX(periodo_hasta) FROM mensualidades_pagos mp
                WHERE mp.id_empresa = m.id_empresa AND mp.id_mensualidad = m.id_mensualidad
            ) AS last_paid_until
             FROM mensualidades m
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON tv.id_tipo = v.id_tipo
             WHERE m.id_mensualidad = ? AND m.id_empresa = ?`,
            [id, idEmpresa]
        );
        if (!mens) return res.status(404).json({ success: false, message: 'Mensualidad no encontrada' });

        const today = new Date(); today.setHours(0, 0, 0, 0);
        const fechaInicio = mens.fecha_inicio ? new Date(mens.fecha_inicio) : null;
        const fechaFin = mens.fecha_fin ? new Date(mens.fecha_fin) : null;
        const lastPaidUntil = mens.last_paid_until ? new Date(mens.last_paid_until) : null;

        let nextStart = fechaInicio ? new Date(fechaInicio) : null;
        if (lastPaidUntil) { const ns = new Date(lastPaidUntil); ns.setDate(ns.getDate() + 1); nextStart = ns; }

        const inactivo = (mens.estado === 'cancelada') || (fechaFin && today > fechaFin) || !nextStart;
        if (inactivo) {
            return res.json({ success: true, data: {
                due_status: 'inactivo',
                valor_mensual: Number(mens.valor_mensual || 0),
                months: 0,
                periodo_desde: null,
                periodo_hasta: null,
                monto: 0
            }});
        }

        const monthsDiff = (b, a) => {
            let m = (b.getFullYear() - a.getFullYear()) * 12 + (b.getMonth() - a.getMonth());
            if (b.getDate() >= a.getDate()) m += 1;
            return m;
        };

        let months = 1;
        let due_status = 'al_dia';
        if (today >= nextStart) {
            months = Math.max(1, monthsDiff(today, nextStart));
            due_status = 'vencido';
        } else {
            const msPerDay = 86400000;
            const daysToNext = Math.ceil((nextStart - today) / msPerDay);
            due_status = daysToNext <= 5 ? 'proximo' : 'al_dia';
        }

        const desdeISO = nextStart.toISOString().slice(0, 10);
        const hastaDate = new Date(nextStart);
        hastaDate.setMonth(hastaDate.getMonth() + months);
        hastaDate.setDate(hastaDate.getDate() - 1);
        const hastaISO = hastaDate.toISOString().slice(0, 10);
        const monto = Number(mens.valor_mensual || 0) * months;

        res.json({ success: true, data: {
            due_status,
            valor_mensual: Number(mens.valor_mensual || 0),
            months,
            periodo_desde: desdeISO,
            periodo_hasta: hastaISO,
            monto
        }});
    } catch (e) {
        console.error('Sugerencia pago GET:', e);
        res.status(500).json({ success: false, message: 'Error al obtener sugerencia de pago' });
    }
});

module.exports = router;
