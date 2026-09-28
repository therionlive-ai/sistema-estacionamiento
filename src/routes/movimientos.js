const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const {
    obtenerConvenio,
    validarConvenio,
    calcularBeneficio,
    registrarBeneficio
} = require('../utils/beneficios');
const requireAdmin = require('../middleware/requireAdmin');

// Obtener tarifa activa por tipo de vehículo para la empresa
// Relacionado con: src/routes/tarifas.js para estructura de tarifas
async function obtenerTarifaActiva(idEmpresa, idTipo, db = pool) {
    const [tarifas] = await db.query(
        `SELECT * FROM tarifas 
         WHERE id_empresa = ? AND id_tipo = ? AND activa = TRUE 
         AND (fecha_vigencia_hasta IS NULL OR fecha_vigencia_hasta >= CURRENT_TIMESTAMP)
         ORDER BY fecha_vigencia_desde DESC LIMIT 1`,
        [idEmpresa, idTipo]
    );
    return tarifas[0] || null;
}

// Calcular total considerando modo de cobro y escalones
function calcularTotalMixto(minutos, tarifa) {
    const valorMin = Number(tarifa.valor_minuto);
    const valorHor = Number(tarifa.valor_hora);
    const valorDia = Number(tarifa.valor_dia_completo);
    const pasoMinAHr = Number(tarifa.paso_minutos_a_horas || 0);
    const pasoHrADia = Number(tarifa.paso_horas_a_dias || 0);
    const redHr = tarifa.redondeo_horas || 'arriba';
    const redDia = tarifa.redondeo_dias || 'arriba';

    let restante = minutos;
    let total = 0;
    let dias = 0, horas = 0, mins = 0;

    // Etapa minutos
    if (pasoMinAHr > 0 && restante > pasoMinAHr) {
        mins = pasoMinAHr;
        total += mins * valorMin;
        restante -= mins;
    } else {
        mins = restante;
        total += mins * valorMin;
        restante = 0;
    }

    // Etapa horas
    if (restante > 0) {
        let horasFloat = restante / 60;
        let horasCobrables = redHr === 'arriba' ? Math.ceil(horasFloat) : Math.floor(horasFloat);
        if (pasoHrADia > 0 && horasCobrables > pasoHrADia) {
            horasCobrables = pasoHrADia;
        }
        horas = horasCobrables;
        total += horas * valorHor;
        restante -= horas * 60;
    }

    // Etapa días
    if (restante > 0) {
        let diasFloat = restante / (24 * 60);
        let diasCobrables = redDia === 'arriba' ? Math.ceil(diasFloat) : Math.floor(diasFloat);
        dias = diasCobrables;
        total += dias * valorDia;
        restante = 0;
    }

    return { total: Number(total.toFixed(2)), dias, horas, minutos: mins };
}

function calcularTotal({ minutos, tarifa }) {
    const valorMin = Number(tarifa.valor_minuto);
    const valorHor = Number(tarifa.valor_hora);
    const valorDia = Number(tarifa.valor_dia_completo);
    const modo = tarifa.modo_cobro || 'mixto';

    if (modo === 'minuto') {
        return { total: Number((minutos * valorMin).toFixed(2)), dias: 0, horas: 0, minutos };
    }
    if (modo === 'hora') {
        const horas = Math.ceil(minutos / 60);
        return { total: Number((horas * valorHor).toFixed(2)), dias: 0, horas, minutos: minutos % 60 };
    }
    if (modo === 'dia') {
        const dias = Math.ceil(minutos / (24 * 60));
        return { total: Number((dias * valorDia).toFixed(2)), dias, horas: 0, minutos: minutos % (24*60) };
    }
    // mixto (escalonado)
    return calcularTotalMixto(minutos, tarifa);
}

// Registrar ingreso
// Relacionado con: public/admin/ingreso-salida.html para formulario de ingreso
router.post('/ingreso', verifyToken, async (req, res) => {
    try {
        const { placa, id_tipo } = req.body;
        const idEmpresa = req.user.id_empresa;

        if (!placa || !id_tipo) {
            return res.status(400).json({ success: false, message: 'Placa y tipo son obligatorios' });
        }

        // Verificar que el tipo existe y está activo
        const [tipo] = await pool.query(
            'SELECT id_tipo, nombre, codigo FROM tipos_vehiculos WHERE id_tipo = ? AND id_empresa = ? AND activo = TRUE',
            [id_tipo, idEmpresa]
        );

        if (tipo.length === 0) {
            return res.status(400).json({ success: false, message: 'Tipo de vehículo no válido o inactivo' });
        }

        const tarifa = await obtenerTarifaActiva(idEmpresa, id_tipo);
        if (!tarifa) {
            return res.status(400).json({ success: false, message: 'No hay tarifa activa para este tipo' });
        }

        // Crear vehículo si no existe
        const [vehiculos] = await pool.query(
            'SELECT id_vehiculo FROM vehiculos WHERE placa = ? AND id_empresa = ?',
            [placa, idEmpresa]
        );
        let idVehiculo;
        if (vehiculos.length === 0) {
            const [ins] = await pool.query(
                'INSERT INTO vehiculos (id_empresa, placa, id_tipo, color) VALUES (?, ?, ?, ?)',
                [idEmpresa, placa.toUpperCase(), id_tipo, 'N/A']
            );
            idVehiculo = ins.insertId;
        } else {
            idVehiculo = vehiculos[0].id_vehiculo;
        }

        // Verificar si ya está activo
        const [activos] = await pool.query(
            'SELECT id_movimiento FROM movimientos WHERE id_vehiculo = ? AND fecha_salida IS NULL',
            [idVehiculo]
        );
        if (activos.length > 0) {
            return res.status(409).json({ success: false, message: 'El vehículo ya está dentro' });
        }

        const [mov] = await pool.query(
            `INSERT INTO movimientos (id_empresa, id_vehiculo, id_tarifa, fecha_entrada, id_usuario_entrada, estado)
             VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'activo')`,
            [idEmpresa, idVehiculo, tarifa.id_tarifa, req.user.id]
        );

        const [fechaRows] = await pool.query(
            'SELECT fecha_entrada FROM movimientos WHERE id_movimiento = ?',
            [mov.insertId]
        );

        const comprobante = {
            movimientoId: mov.insertId,
            placa: placa.toUpperCase(),
            tipo: tipo[0].nombre,
            tipo_codigo: tipo[0].codigo,
            fechaEntrada: fechaRows[0].fecha_entrada,
            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            }
        };

        res.status(201).json({ success: true, data: comprobante, message: 'Ingreso registrado' });
    } catch (error) {
        console.error('Error ingreso:', error);
        res.status(500).json({ success: false, message: 'Error al registrar ingreso' });
    }
});


// Buscar convenio por código dentro de la empresa.
async function obtenerConvenioPorCodigo(db, idEmpresa, codigo) {
    const [rows] = await db.query(
        `SELECT *
         FROM convenios
         WHERE id_empresa = ?
           AND codigo = ?
           AND activo = TRUE
         LIMIT 1`,
        [idEmpresa, codigo]
    );

    return rows[0] || null;
}

// Calcular total sin finalizar
// Incluye convenios y cortesía automática menor a 15 minutos.
router.post('/calcular-salida', verifyToken, async (req, res) => {
    try {
        const {
            placa,
            id_convenio = null,
            referencia_beneficio = null
        } = req.body;

        const idEmpresa = req.user.id_empresa;

        if (!placa) {
            return res.status(400).json({
                success: false,
                message: 'Placa es obligatoria'
            });
        }

        const [vehiculos] = await pool.query(
            `SELECT
                v.id_vehiculo,
                v.id_tipo,
                tv.nombre AS tipo,
                tv.codigo AS tipo_codigo
             FROM vehiculos v
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE v.placa = ?
               AND v.id_empresa = ?`,
            [placa, idEmpresa]
        );

        if (vehiculos.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'Vehículo no encontrado'
            });
        }

        const vehiculo = vehiculos[0];

        const [movs] = await pool.query(
            `SELECT *
             FROM movimientos
             WHERE id_vehiculo = ?
               AND id_empresa = ?
               AND fecha_salida IS NULL
             LIMIT 1`,
            [vehiculo.id_vehiculo, idEmpresa]
        );

        if (movs.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'El vehículo no tiene ingreso activo'
            });
        }

        const mov = movs[0];

        const tarifa = await obtenerTarifaActiva(
            idEmpresa,
            vehiculo.id_tipo
        );

        if (!tarifa) {
            return res.status(400).json({
                success: false,
                message: 'No hay tarifa activa para este tipo'
            });
        }

        const [tiempo] = await pool.query(
            `SELECT
                TIMESTAMPDIFF(MINUTE, ?, CURRENT_TIMESTAMP) AS minutos,
                CURRENT_TIMESTAMP AS ahora`,
            [mov.fecha_entrada]
        );

        const minutos = Math.max(0, Number(tiempo[0].minutos || 0));

        const calculoNormal = calcularTotal({
            minutos,
            tarifa
        });

        const totalOriginal = calculoNormal.total;

        let convenio = null;
        let resultadoBeneficio = null;

        /*
         * PRIORIDAD 1:
         * Convenio explícitamente autorizado.
         */
        if (id_convenio) {
            const validacion = await validarConvenio({
                conn: pool,
                idEmpresa,
                idConvenio: id_convenio,
                referenciaBeneficio: referencia_beneficio,
                fecha: new Date(),
                fechaHorario: mov.fecha_entrada
            });

            if (!validacion.valido) {
                return res.status(400).json({
                    success: false,
                    message: validacion.mensaje
                });
            }

            convenio = validacion.convenio;
        }

        /*
         * PRIORIDAD 2:
         * Cortesía automática menor a 15 minutos.
         *
         * No requiere selección del cajero.
         */
        if (!convenio && minutos < 15) {
            convenio = await obtenerConvenioPorCodigo(
                pool,
                idEmpresa,
                'CORTESIA_15_MIN'
            );

            if (!convenio) {
                return res.status(500).json({
                    success: false,
                    message: 'No está configurada la cortesía automática CORTESIA_15_MIN'
                });
            }
        }

        let totalFinal = totalOriginal;
        let minutosGratis = 0;
        let descuento = 0;
        let motivo = null;

        if (convenio) {
            /*
             * Convenio de vehículo gratis.
             */
            if (convenio.tipo_beneficio === 'vehiculo_gratis') {
                minutosGratis = minutos;
                totalFinal = 0;
                descuento = totalOriginal;
            }

            /*
             * Convenio de horas gratis.
             *
             * Ejemplo:
             * 2 horas gratis + 150 minutos de permanencia
             * = se cobran únicamente los 30 minutos excedentes.
             */
            else if (convenio.tipo_beneficio === 'horas_gratis') {
                const horasGratis = Math.max(
                    0,
                    Number(convenio.valor_beneficio || 0)
                );

                minutosGratis = Math.min(
                    minutos,
                    Math.round(horasGratis * 60)
                );

                const minutosFacturables = Math.max(
                    0,
                    minutos - minutosGratis
                );

                const calculoExcedente = calcularTotal({
                    minutos: minutosFacturables,
                    tarifa
                });

                totalFinal = calculoExcedente.total;
                descuento = Math.max(
                    0,
                    Number((totalOriginal - totalFinal).toFixed(2))
                );
            }

            /*
             * Descuento porcentual.
             */
            else if (convenio.tipo_beneficio === 'porcentaje') {
                const porcentaje = Math.min(
                    100,
                    Math.max(0, Number(convenio.valor_beneficio || 0))
                );

                descuento = Number(
                    (totalOriginal * porcentaje / 100).toFixed(2)
                );

                totalFinal = Number(
                    (totalOriginal - descuento).toFixed(2)
                );
            }

            /*
             * Descuento por monto.
             */
            else if (convenio.tipo_beneficio === 'monto') {
                descuento = Math.min(
                    totalOriginal,
                    Math.max(0, Number(convenio.valor_beneficio || 0))
                );

                descuento = Number(descuento.toFixed(2));
                totalFinal = Number(
                    (totalOriginal - descuento).toFixed(2)
                );
            }

            else {
                return res.status(400).json({
                    success: false,
                    message: `El tipo de beneficio "${convenio.tipo_beneficio}" todavía no está habilitado para cobro`
                });
            }

            motivo =
                convenio.codigo ||
                convenio.nombre ||
                'CONVENIO';
        }

        const factura = {
            movimientoId: mov.id_movimiento,
            placa: placa.toUpperCase(),
            tipo: vehiculo.tipo,
            tipo_codigo: vehiculo.tipo_codigo,
            fechaEntrada: mov.fecha_entrada,
            fechaSalida: tiempo[0].ahora,

            detalleTiempo: {
                dias: calculoNormal.dias,
                horas: calculoNormal.horas,
                minutos: calculoNormal.minutos
            },

            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            },

            totalOriginal,
            total: Number(totalFinal.toFixed(2)),

            beneficio: convenio ? {
                aplicado: true,
                id_convenio: convenio.id_convenio,
                codigo: convenio.codigo || null,
                nombre: convenio.nombre,
                tipo_beneficiario: convenio.tipo_beneficiario,
                tipo_beneficio: convenio.tipo_beneficio,
                minutosGratis,
                descuento: Number(descuento.toFixed(2)),
                referencia: referencia_beneficio || null,
                motivo
            } : {
                aplicado: false,
                minutosGratis: 0,
                descuento: 0
            }
        };

        res.json({
            success: true,
            data: factura,
            message: convenio
                ? 'Total calculado con beneficio'
                : 'Total calculado'
        });

    } catch (error) {
        console.error('Error calcular salida:', error);

        res.status(500).json({
            success: false,
            message: 'Error al calcular total'
        });
    }
});


// Confirmar salida y registrar pagos.
// Recalcula nuevamente el beneficio dentro de una transacción.
router.post('/confirmar-salida', verifyToken, async (req, res) => {
    let conn = null;

    try {
        const {
            id_movimiento,
            pagos = [],
            id_convenio = null,
            referencia_beneficio = null
        } = req.body;

        const idEmpresa = req.user.id_empresa;

        if (!id_movimiento) {
            return res.status(400).json({
                success: false,
                message: 'ID de movimiento es obligatorio'
            });
        }

        if (!Array.isArray(pagos)) {
            return res.status(400).json({
                success: false,
                message: 'Formato de pagos inválido'
            });
        }

        conn = await pool.getConnection();

        await conn.beginTransaction();

        /*
         * Bloqueamos el movimiento para evitar que dos cajeros
         * intenten finalizarlo simultáneamente.
         */
        const [movs] = await conn.query(
            `SELECT
                m.*,
                v.placa,
                v.id_tipo,
                tv.nombre AS tipo,
                tv.codigo AS tipo_codigo
             FROM movimientos m
             JOIN vehiculos v ON m.id_vehiculo = v.id_vehiculo
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE m.id_movimiento = ?
               AND m.id_empresa = ?
               AND m.fecha_salida IS NULL
             FOR UPDATE`,
            [id_movimiento, idEmpresa]
        );

        if (movs.length === 0) {
            await conn.rollback();

            return res.status(404).json({
                success: false,
                message: 'Movimiento no encontrado o ya fue finalizado'
            });
        }

        const mov = movs[0];

        const tarifa = await obtenerTarifaActiva(
            idEmpresa,
            mov.id_tipo,
            conn
        );

        if (!tarifa) {
            await conn.rollback();

            return res.status(400).json({
                success: false,
                message: 'No hay tarifa activa para este tipo'
            });
        }

        const [tiempo] = await conn.query(
            `SELECT
                TIMESTAMPDIFF(MINUTE, ?, CURRENT_TIMESTAMP) AS minutos,
                CURRENT_TIMESTAMP AS ahora`,
            [mov.fecha_entrada]
        );

        const minutos = Math.max(
            0,
            Number(tiempo[0].minutos || 0)
        );

        const calculoNormal = calcularTotal({
            minutos,
            tarifa
        });

        const totalOriginal = calculoNormal.total;

        let convenio = null;

        /*
         * PRIORIDAD 1:
         * Convenio explícito.
         */
        if (id_convenio) {
            const validacion = await validarConvenio({
                conn,
                idEmpresa,
                idConvenio: id_convenio,
                referenciaBeneficio: referencia_beneficio,
                fecha: new Date(),
                fechaHorario: mov.fecha_entrada
            });

            if (!validacion.valido) {
                await conn.rollback();

                return res.status(400).json({
                    success: false,
                    message: validacion.mensaje
                });
            }

            convenio = validacion.convenio;
        }

        /*
         * PRIORIDAD 2:
         * Cortesía automática < 15 minutos.
         */
        if (!convenio && minutos < 15) {
            convenio = await obtenerConvenioPorCodigo(
                conn,
                idEmpresa,
                'CORTESIA_15_MIN'
            );

            if (!convenio) {
                await conn.rollback();

                return res.status(500).json({
                    success: false,
                    message: 'No está configurada la cortesía automática CORTESIA_15_MIN'
                });
            }
        }

        let totalFinal = totalOriginal;
        let minutosGratis = 0;
        let descuento = 0;
        let motivo = null;

        if (convenio) {

            if (convenio.tipo_beneficio === 'vehiculo_gratis') {
                minutosGratis = minutos;
                totalFinal = 0;
                descuento = totalOriginal;
            }

            else if (convenio.tipo_beneficio === 'horas_gratis') {
                const horasGratis = Math.max(
                    0,
                    Number(convenio.valor_beneficio || 0)
                );

                minutosGratis = Math.min(
                    minutos,
                    Math.round(horasGratis * 60)
                );

                const minutosFacturables = Math.max(
                    0,
                    minutos - minutosGratis
                );

                const calculoExcedente = calcularTotal({
                    minutos: minutosFacturables,
                    tarifa
                });

                totalFinal = calculoExcedente.total;

                descuento = Math.max(
                    0,
                    Number((totalOriginal - totalFinal).toFixed(2))
                );
            }

            else if (convenio.tipo_beneficio === 'porcentaje') {
                const porcentaje = Math.min(
                    100,
                    Math.max(0, Number(convenio.valor_beneficio || 0))
                );

                descuento = Number(
                    (totalOriginal * porcentaje / 100).toFixed(2)
                );

                totalFinal = Number(
                    (totalOriginal - descuento).toFixed(2)
                );
            }

            else if (convenio.tipo_beneficio === 'monto') {
                descuento = Math.min(
                    totalOriginal,
                    Math.max(0, Number(convenio.valor_beneficio || 0))
                );

                descuento = Number(descuento.toFixed(2));

                totalFinal = Number(
                    (totalOriginal - descuento).toFixed(2)
                );
            }

            else {
                await conn.rollback();

                return res.status(400).json({
                    success: false,
                    message: `El tipo de beneficio "${convenio.tipo_beneficio}" todavía no está habilitado para cobro`
                });
            }

            motivo =
                convenio.codigo ||
                convenio.nombre ||
                'CONVENIO';
        }

        totalFinal = Number(totalFinal.toFixed(2));

        /*
         * Un movimiento con total L 0.00 puede finalizar
         * sin registrar ningún pago.
         */
        const pagosValidos = pagos
            .filter(p =>
                p &&
                p.metodo_pago &&
                Number(p.monto) > 0
            )
            .map(p => ({
                metodo_pago: p.metodo_pago,
                monto: Number(Number(p.monto).toFixed(2))
            }));

        const totalPagado = Number(
            pagosValidos
                .reduce((sum, p) => sum + p.monto, 0)
                .toFixed(2)
        );

        if (totalPagado + 0.0001 < totalFinal) {
            await conn.rollback();

            return res.status(400).json({
                success: false,
                message: `El total pagado (${totalPagado.toFixed(2)}) es menor al total a pagar (${totalFinal.toFixed(2)})`
            });
        }

        /*
         * Registrar salida.
         */
        await conn.query(
            `UPDATE movimientos
             SET fecha_salida = CURRENT_TIMESTAMP,
                 total_a_pagar = ?,
                 estado = 'finalizado',
                 id_usuario_salida = ?
             WHERE id_movimiento = ?
               AND id_empresa = ?
               AND fecha_salida IS NULL`,
            [
                totalFinal,
                req.user.id,
                id_movimiento,
                idEmpresa
            ]
        );

        /*
         * Registrar pagos solamente cuando realmente existen.
         */
        if (pagosValidos.length > 0) {
            const valoresPagos = pagosValidos.map(p => [
                idEmpresa,
                id_movimiento,
                p.metodo_pago,
                p.monto,
                req.user.id
            ]);

            await conn.query(
                `INSERT INTO pagos
                (
                    id_empresa,
                    id_movimiento,
                    metodo_pago,
                    monto,
                    id_usuario
                )
                VALUES ?`,
                [valoresPagos]
            );
        }

        /*
         * Registrar trazabilidad del beneficio.
         */
        if (convenio) {
            await registrarBeneficio({
                conn,
                idEmpresa,
                idMovimiento: id_movimiento,
                idConvenio: convenio.id_convenio,
                minutosGratis,
                descuento,
                totalOriginal,
                totalFinal,
                motivo,
                referenciaBeneficio: referencia_beneficio,
                aplicadoPor: req.user.id
            });
        }

        await conn.commit();

        const [fechaSalidaRows] = await conn.query(
            `SELECT fecha_salida
             FROM movimientos
             WHERE id_movimiento = ?`,
            [id_movimiento]
        );

        const factura = {
            movimientoId: mov.id_movimiento,
            placa: mov.placa.toUpperCase(),
            tipo: mov.tipo,
            tipo_codigo: mov.tipo_codigo,
            fechaEntrada: mov.fecha_entrada,
            fechaSalida: fechaSalidaRows[0].fecha_salida,

            detalleTiempo: {
                dias: calculoNormal.dias,
                horas: calculoNormal.horas,
                minutos: calculoNormal.minutos
            },

            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            },

            totalOriginal,
            total: totalFinal,

            beneficio: convenio ? {
                aplicado: true,
                id_convenio: convenio.id_convenio,
                codigo: convenio.codigo || null,
                nombre: convenio.nombre,
                tipo_beneficiario: convenio.tipo_beneficiario,
                tipo_beneficio: convenio.tipo_beneficio,
                minutosGratis,
                descuento,
                referencia: referencia_beneficio || null,
                motivo
            } : {
                aplicado: false,
                minutosGratis: 0,
                descuento: 0
            },

            pagosList: pagosValidos
        };

        res.json({
            success: true,
            data: factura,
            message: convenio
                ? 'Salida confirmada y beneficio registrado'
                : 'Salida confirmada y pagos registrados'
        });

    } catch (error) {

        if (conn) {
            try {
                await conn.rollback();
            } catch (_) {}
        }

        console.error('Error confirmar salida:', error);

        res.status(500).json({
            success: false,
            message: 'Error al confirmar la salida'
        });

    } finally {

        if (conn) {
            conn.release();
        }
    }
});


// Registrar salida y calcular total (mantener para compatibilidad con código existente)
// Relacionado con: public/admin/ingreso-salida.html y otros lugares que usan el endpoint antiguo
router.post('/salida', verifyToken, async (req, res) => {
    try {
        const { placa, metodoPago } = req.body;
        const idEmpresa = req.user.id_empresa;
        if (!placa) {
            return res.status(400).json({ success: false, message: 'Placa es obligatoria' });
        }

        const [vehiculos] = await pool.query(
            `SELECT v.id_vehiculo, v.id_tipo, tv.nombre as tipo, tv.codigo as tipo_codigo 
             FROM vehiculos v
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE v.placa = ? AND v.id_empresa = ?`,
            [placa, idEmpresa]
        );
        if (vehiculos.length === 0) {
            return res.status(404).json({ success: false, message: 'Vehículo no encontrado' });
        }
        const vehiculo = vehiculos[0];

        const [movs] = await pool.query(
            'SELECT * FROM movimientos WHERE id_vehiculo = ? AND fecha_salida IS NULL',
            [vehiculo.id_vehiculo]
        );
        if (movs.length === 0) {
            return res.status(404).json({ success: false, message: 'El vehículo no tiene ingreso activo' });
        }
        const mov = movs[0];

        const tarifa = await obtenerTarifaActiva(idEmpresa, vehiculo.id_tipo);
        if (!tarifa) {
            return res.status(400).json({ success: false, message: 'No hay tarifa activa para este tipo' });
        }

        const [tiempo] = await pool.query(
            'SELECT TIMESTAMPDIFF(MINUTE, ?, CURRENT_TIMESTAMP) as minutos',
            [mov.fecha_entrada]
        );
        const minutos = tiempo[0].minutos;
        const { total, dias, horas, minutos: mins } = calcularTotal({ minutos, tarifa });

        await pool.query(
            `UPDATE movimientos SET fecha_salida = CURRENT_TIMESTAMP, total_a_pagar = ?, estado = 'finalizado', id_usuario_salida = ?
             WHERE id_movimiento = ?`,
            [total, req.user.id, mov.id_movimiento]
        );

        if (metodoPago) {
            await pool.query(
                `INSERT INTO pagos (id_empresa, id_movimiento, metodo_pago, monto, id_usuario)
                 VALUES (?, ?, ?, ?, ?)`,
                [idEmpresa, mov.id_movimiento, metodoPago, total, req.user.id]
            );
        }

        const [fechaSalidaRows] = await pool.query(
            'SELECT fecha_salida FROM movimientos WHERE id_movimiento = ?',
            [mov.id_movimiento]
        );

        const factura = {
            movimientoId: mov.id_movimiento,
            placa: placa.toUpperCase(),
            tipo: vehiculo.tipo,
            tipo_codigo: vehiculo.tipo_codigo,
            fechaEntrada: mov.fecha_entrada,
            fechaSalida: fechaSalidaRows[0].fecha_salida,
            detalleTiempo: { dias, horas, minutos: mins },
            tarifa: {
                valor_minuto: tarifa.valor_minuto,
                valor_hora: tarifa.valor_hora,
                valor_dia_completo: tarifa.valor_dia_completo
            },
            total
        };

        res.json({ success: true, data: factura, message: 'Salida registrada' });
    } catch (error) {
        console.error('Error salida:', error);
        res.status(500).json({ success: false, message: 'Error al registrar salida' });
    }
});

// Revertir salida (reactivar movimiento) - útil cuando se cancela el pago
// Relacionado con: public/admin/ingreso-salida.html cuando se cancela el modal de pago
router.post('/revertir-salida', verifyToken, requireAdmin, async (req, res) => {
    try {
        const { id_movimiento } = req.body;
        const idEmpresa = req.user.id_empresa;

        if (!id_movimiento) {
            return res.status(400).json({ success: false, message: 'ID de movimiento es obligatorio' });
        }

        // Verificar que el movimiento pertenece a la empresa y está finalizado
        const [movs] = await pool.query(
            `SELECT m.* FROM movimientos m 
             WHERE m.id_movimiento = ? AND m.id_empresa = ? AND m.estado = 'finalizado'`,
            [id_movimiento, idEmpresa]
        );

        if (movs.length === 0) {
            // Intentar buscar el movimiento aunque no esté finalizado (por si acaso)
            const [movs2] = await pool.query(
                `SELECT m.* FROM movimientos m 
                 WHERE m.id_movimiento = ? AND m.id_empresa = ?`,
                [id_movimiento, idEmpresa]
            );
            
            if (movs2.length === 0) {
                return res.status(404).json({ 
                    success: false, 
                    message: 'Movimiento no encontrado' 
                });
            }
            
            // Si el movimiento existe pero no está finalizado, puede que ya se haya revertido
            if (movs2[0].estado === 'activo') {
                return res.json({ 
                    success: true, 
                    message: 'El movimiento ya está activo' 
                });
            }
            
            return res.status(400).json({ 
                success: false, 
                message: 'El movimiento no está en estado finalizado' 
            });
        }

        const mov = movs[0];

        // Verificar que no tenga pagos registrados
        const [pagos] = await pool.query(
            'SELECT COUNT(*) as total FROM pagos WHERE id_movimiento = ?',
            [id_movimiento]
        );

        if (pagos[0].total > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'No se puede revertir un movimiento que ya tiene pagos registrados' 
            });
        }

        // Revertir la salida: poner fecha_salida en NULL, estado en 'activo', y limpiar total_a_pagar
        const [result] = await pool.query(
            `UPDATE movimientos 
             SET fecha_salida = NULL, 
                 estado = 'activo', 
                 total_a_pagar = NULL,
                 id_usuario_salida = NULL
             WHERE id_movimiento = ? AND id_empresa = ?`,
            [id_movimiento, idEmpresa]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ 
                success: false, 
                message: 'No se pudo actualizar el movimiento' 
            });
        }

        res.json({ 
            success: true, 
            message: 'Salida revertida exitosamente. El vehículo está activo nuevamente.' 
        });
    } catch (error) {
        console.error('Error al revertir salida:', error);
        res.status(500).json({ 
            success: false, 
            message: 'Error al revertir la salida: ' + (error.message || 'Error desconocido') 
        });
    }
});

module.exports = router;

// Detalle por id_movimiento (para dashboard)
const { sanitizeIdParam } = require('../utils/sanitize');
router.get('/detalle/:id', verifyToken, sanitizeIdParam('id'), async (req, res) => {
    try {
        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo
             FROM movimientos m 
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             WHERE m.id_movimiento = ? AND m.id_empresa = ?`,
            [req.params.id, req.user.id_empresa]
        );
        if (rows.length === 0) return res.status(404).json({ success: false, message: 'No encontrado' });
        res.json({ success: true, data: rows[0] });
    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, message: 'Error obteniendo detalle' });
    }
});

// Factura completa para reimpresión (incluye tarifa usada, tiempos y pagos)
router.get('/factura/:id', verifyToken, sanitizeIdParam('id'), async (req, res) => {
    try {
        const idMov = req.params.id;
        const [rows] = await pool.query(
            `SELECT m.*, v.placa, tv.nombre as tipo, tv.codigo as tipo_codigo, t.valor_minuto, t.valor_hora, t.valor_dia_completo
             FROM movimientos m
             JOIN vehiculos v ON v.id_vehiculo = m.id_vehiculo
             JOIN tipos_vehiculos tv ON v.id_tipo = tv.id_tipo
             JOIN tarifas t ON t.id_tarifa = m.id_tarifa
             WHERE m.id_movimiento = ? AND m.id_empresa = ?`
            , [idMov, req.user.id_empresa]
        );
        if (rows.length === 0) return res.status(404).json({ success:false, message:'Movimiento no encontrado' });
        const m = rows[0];
        if (!m.fecha_salida) return res.status(400).json({ success:false, message:'Movimiento no finalizado' });
        // Calcular tiempos en SQL (DATETIME naive, sin desfase por TZ de Node)
        const [diffRows] = await pool.query(
            'SELECT TIMESTAMPDIFF(MINUTE, ?, ?) as minutos',
            [m.fecha_entrada, m.fecha_salida]
        );
        const diffMin = Math.max(0, Number(diffRows[0].minutos) || 0);
        const dias = Math.floor(diffMin / (24*60));
        const remMin1 = diffMin % (24*60);
        const horas = Math.floor(remMin1 / 60);
        const minutos = remMin1 % 60;
        // Pagos
        const [pRows] = await pool.query(
            `SELECT metodo_pago, monto FROM pagos WHERE id_empresa = ? AND id_movimiento = ? ORDER BY id_pago ASC`,
            [req.user.id_empresa, idMov]
        );
        const factura = {
            movimientoId: m.id_movimiento,
            placa: m.placa,
            tipo: m.tipo,
            fechaEntrada: m.fecha_entrada,
            fechaSalida: m.fecha_salida,
            detalleTiempo: { dias, horas, minutos },
            tarifa: {
                valor_minuto: m.valor_minuto,
                valor_hora: m.valor_hora,
                valor_dia_completo: m.valor_dia_completo
            },
            total: Number(m.total_a_pagar||0),
            pagosList: pRows.map(p=>({ metodo_pago: p.metodo_pago, monto: Number(p.monto||0) }))
        };
        res.json({ success:true, data: factura });
    } catch (e) {
        console.error('movimientos/factura', e);
        res.status(500).json({ success:false, message:'Error obteniendo factura' });
    }
});


