const express = require('express');
const router = express.Router();

const pool = require('../config/db');
const auth = require('../middleware/auth');
const requireRoles = require('../middleware/requireRoles');

router.use(auth);

/**
 * Obtener IP de origen
 */
function obtenerIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.socket?.remoteAddress ||
        null
    );
}

/**
 * Convertir valores a JSON para auditoría
 */
function jsonSeguro(valor) {
    if (valor === null || valor === undefined) {
        return null;
    }

    return JSON.stringify(valor);
}

/**
 * Snapshot del convenio
 */
function snapshotConvenio(row) {
    if (!row) {
        return null;
    }

    return {
        id_convenio: row.id_convenio,
        id_empresa: row.id_empresa,
        nombre: row.nombre,
        codigo: row.codigo,
        descripcion: row.descripcion,
        tipo_beneficiario: row.tipo_beneficiario,
        identificador_beneficiario: row.identificador_beneficiario,
        tipo_beneficio: row.tipo_beneficio,
        valor_beneficio: row.valor_beneficio,
        hora_desde: row.hora_desde,
        hora_hasta: row.hora_hasta,
        requiere_sello: row.requiere_sello,
        usos_por_periodo: row.usos_por_periodo,
        periodicidad_uso: row.periodicidad_uso,
        activo: row.activo,
        fecha_inicio: row.fecha_inicio,
        fecha_fin: row.fecha_fin
    };
}

/**
 * Registrar auditoría
 */
async function registrarAuditoria({
    req,
    idConvenio,
    accion,
    datosAnteriores = null,
    datosNuevos = null
}) {
    await pool.query(
        `INSERT INTO auditoria_convenios (
            id_empresa,
            id_convenio,
            id_usuario,
            nombre_usuario,
            rol_usuario,
            accion,
            datos_anteriores,
            datos_nuevos,
            ip_origen
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            req.user.id_empresa,
            idConvenio,
            req.user.id_usuario,
            req.user.nombre || req.user.usuario_login || 'Usuario',
            req.user.rol,
            accion,
            jsonSeguro(datosAnteriores),
            jsonSeguro(datosNuevos),
            obtenerIP(req)
        ]
    );
}

const TIPOS_BENEFICIO = [
    'horas_gratis',
    'porcentaje',
    'monto',
    'tarifa_especial',
    'indefinido_horario',
    'vehiculo_gratis'
];

const TIPOS_BENEFICIARIO = [
    'sistema',
    'tienda',
    'gimnasio',
    'general'
];

const PERIODICIDADES = [
    'ninguno',
    'diario',
    'semanal',
    'mensual'
];

/**
 * CONSULTAR TODOS LOS CONVENIOS
 */
router.get(
    '/',
    requireRoles('admin', 'operador'),
    async (req, res) => {
        try {
            const [rows] = await pool.query(
                `SELECT *
                 FROM convenios
                 WHERE id_empresa = ?
                 ORDER BY id_convenio DESC`,
                [req.user.id_empresa]
            );

            res.json({
                success: true,
                data: rows
            });

        } catch (error) {
            console.error('Error listando convenios:', error);

            res.status(500).json({
                success: false,
                message: 'Error listando convenios'
            });
        }
    }
);

/**
 * CONSULTAR AUDITORÍA
 *
 * IMPORTANTE:
 * Esta ruta está antes de /:id
 */
router.get(
    '/:id/auditoria',
    requireRoles('admin', 'operador'),
    async (req, res) => {
        try {
            const [rows] = await pool.query(
                `SELECT
                    id_auditoria,
                    id_empresa,
                    id_convenio,
                    id_usuario,
                    nombre_usuario,
                    rol_usuario,
                    accion,
                    datos_anteriores,
                    datos_nuevos,
                    ip_origen,
                    fecha_hora
                 FROM auditoria_convenios
                 WHERE id_empresa = ?
                   AND id_convenio = ?
                 ORDER BY fecha_hora DESC,
                          id_auditoria DESC`,
                [
                    req.user.id_empresa,
                    req.params.id
                ]
            );

            res.json({
                success: true,
                data: rows
            });

        } catch (error) {
            console.error('Error consultando auditoría:', error);

            res.status(500).json({
                success: false,
                message: 'Error consultando auditoría'
            });
        }
    }
);

/**
 * CONSULTAR UN CONVENIO
 */
router.get(
    '/:id',
    requireRoles('admin', 'operador'),
    async (req, res) => {
        try {
            const [rows] = await pool.query(
                `SELECT *
                 FROM convenios
                 WHERE id_empresa = ?
                   AND id_convenio = ?
                 LIMIT 1`,
                [
                    req.user.id_empresa,
                    req.params.id
                ]
            );

            if (!rows.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Convenio no encontrado'
                });
            }

            res.json({
                success: true,
                data: rows[0]
            });

        } catch (error) {
            console.error('Error consultando convenio:', error);

            res.status(500).json({
                success: false,
                message: 'Error consultando convenio'
            });
        }
    }
);

/**
 * CREAR CONVENIO
 *
 * Admin / Operador
 */
router.post(
    '/',
    requireRoles('admin', 'operador'),
    async (req, res) => {

        const {
            nombre,
            codigo,
            descripcion,
            tipo_beneficiario,
            identificador_beneficiario,
            tipo_beneficio,
            valor_beneficio,
            hora_desde,
            hora_hasta,
            requiere_sello,
            usos_por_periodo,
            periodicidad_uso,
            activo,
            fecha_inicio,
            fecha_fin
        } = req.body;

        try {

            if (!nombre || !String(nombre).trim()) {
                return res.status(400).json({
                    success: false,
                    message: 'El nombre del convenio es obligatorio'
                });
            }

            if (!tipo_beneficio) {
                return res.status(400).json({
                    success: false,
                    message: 'El tipo de beneficio es obligatorio'
                });
            }

            if (!TIPOS_BENEFICIO.includes(tipo_beneficio)) {
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de beneficio inválido'
                });
            }

            const tipoBeneficiarioFinal =
                tipo_beneficiario || 'general';

            if (!TIPOS_BENEFICIARIO.includes(tipoBeneficiarioFinal)) {
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de beneficiario inválido'
                });
            }

            const periodicidadFinal =
                periodicidad_uso || 'ninguno';

            if (!PERIODICIDADES.includes(periodicidadFinal)) {
                return res.status(400).json({
                    success: false,
                    message: 'Periodicidad inválida'
                });
            }

            const valor =
                Number(valor_beneficio || 0);

            const usos =
                Number(usos_por_periodo || 0);

            if (!Number.isFinite(valor) || valor < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'El valor del beneficio no es válido'
                });
            }

            if (!Number.isInteger(usos) || usos < 0) {
                return res.status(400).json({
                    success: false,
                    message: 'El límite de usos no es válido'
                });
            }

            const [result] = await pool.query(
                `INSERT INTO convenios (
                    id_empresa,
                    nombre,
                    codigo,
                    descripcion,
                    tipo_beneficiario,
                    identificador_beneficiario,
                    tipo_beneficio,
                    valor_beneficio,
                    hora_desde,
                    hora_hasta,
                    requiere_sello,
                    usos_por_periodo,
                    periodicidad_uso,
                    activo,
                    fecha_inicio,
                    fecha_fin
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    req.user.id_empresa,
                    String(nombre).trim(),
                    codigo || null,
                    descripcion || null,
                    tipoBeneficiarioFinal,
                    identificador_beneficiario || null,
                    tipo_beneficio,
                    valor,
                    hora_desde || null,
                    hora_hasta || null,
                    requiere_sello ? 1 : 0,
                    usos,
                    periodicidadFinal,
                    activo === false ? 0 : 1,
                    fecha_inicio || null,
                    fecha_fin || null
                ]
            );

            const idConvenio = result.insertId;

            const [rows] = await pool.query(
                `SELECT *
                 FROM convenios
                 WHERE id_empresa = ?
                   AND id_convenio = ?
                 LIMIT 1`,
                [
                    req.user.id_empresa,
                    idConvenio
                ]
            );

            const nuevoConvenio =
                snapshotConvenio(rows[0]);

            await registrarAuditoria({
                req,
                idConvenio,
                accion: 'crear',
                datosNuevos: nuevoConvenio
            });

            res.json({
                success: true,
                data: nuevoConvenio,
                message: 'Convenio creado correctamente'
            });

        } catch (error) {
            console.error('Error creando convenio:', error);

            res.status(500).json({
                success: false,
                message: 'Error creando convenio'
            });
        }
    }
);

/**
 * MODIFICAR CONVENIO
 *
 * Admin / Operador
 */
router.put(
    '/:id',
    requireRoles('admin', 'operador'),
    async (req, res) => {

        const connection =
            await pool.getConnection();

        try {

            await connection.beginTransaction();

            const [existentes] =
                await connection.query(
                    `SELECT *
                     FROM convenios
                     WHERE id_empresa = ?
                       AND id_convenio = ?
                     FOR UPDATE`,
                    [
                        req.user.id_empresa,
                        req.params.id
                    ]
                );

            if (!existentes.length) {

                await connection.rollback();

                return res.status(404).json({
                    success: false,
                    message: 'Convenio no encontrado'
                });
            }

            const anterior =
                snapshotConvenio(existentes[0]);

            const permitidos = [
                'nombre',
                'codigo',
                'descripcion',
                'tipo_beneficiario',
                'identificador_beneficiario',
                'tipo_beneficio',
                'valor_beneficio',
                'hora_desde',
                'hora_hasta',
                'requiere_sello',
                'usos_por_periodo',
                'periodicidad_uso',
                'activo',
                'fecha_inicio',
                'fecha_fin'
            ];

            const fields = [];
            const values = [];

            for (const campo of permitidos) {

                if (req.body[campo] === undefined) {
                    continue;
                }

                let valor = req.body[campo];

                if (campo === 'valor_beneficio') {
                    valor = Number(valor);

                    if (!Number.isFinite(valor) || valor < 0) {
                        await connection.rollback();

                        return res.status(400).json({
                            success: false,
                            message: 'El valor del beneficio no es válido'
                        });
                    }
                }

                if (campo === 'usos_por_periodo') {
                    valor = Number(valor);

                    if (!Number.isInteger(valor) || valor < 0) {
                        await connection.rollback();

                        return res.status(400).json({
                            success: false,
                            message: 'El límite de usos no es válido'
                        });
                    }
                }

                if (
                    campo === 'requiere_sello' ||
                    campo === 'activo'
                ) {
                    valor = valor ? 1 : 0;
                }

                if (campo === 'nombre') {
                    valor = String(valor).trim();

                    if (!valor) {
                        await connection.rollback();

                        return res.status(400).json({
                            success: false,
                            message: 'El nombre del convenio es obligatorio'
                        });
                    }
                }

                if (
                    campo === 'tipo_beneficio' &&
                    !TIPOS_BENEFICIO.includes(valor)
                ) {
                    await connection.rollback();

                    return res.status(400).json({
                        success: false,
                        message: 'Tipo de beneficio inválido'
                    });
                }

                if (
                    campo === 'tipo_beneficiario' &&
                    !TIPOS_BENEFICIARIO.includes(valor)
                ) {
                    await connection.rollback();

                    return res.status(400).json({
                        success: false,
                        message: 'Tipo de beneficiario inválido'
                    });
                }

                if (
                    campo === 'periodicidad_uso' &&
                    !PERIODICIDADES.includes(valor)
                ) {
                    await connection.rollback();

                    return res.status(400).json({
                        success: false,
                        message: 'Periodicidad inválida'
                    });
                }

                fields.push(`${campo} = ?`);
                values.push(valor);
            }

            if (!fields.length) {
                await connection.rollback();

                return res.status(400).json({
                    success: false,
                    message: 'No hay información para actualizar'
                });
            }

            values.push(
                req.user.id_empresa,
                req.params.id
            );

            await connection.query(
                `UPDATE convenios
                 SET ${fields.join(', ')}
                 WHERE id_empresa = ?
                   AND id_convenio = ?`,
                values
            );

            const [actualizados] =
                await connection.query(
                    `SELECT *
                     FROM convenios
                     WHERE id_empresa = ?
                       AND id_convenio = ?
                     LIMIT 1`,
                    [
                        req.user.id_empresa,
                        req.params.id
                    ]
                );

            const nuevo =
                snapshotConvenio(actualizados[0]);

            const huboCambios =
                JSON.stringify(anterior) !==
                JSON.stringify(nuevo);

            if (!huboCambios) {

                await connection.commit();

                return res.json({
                    success: true,
                    message: 'No se detectaron cambios',
                    data: nuevo
                });
            }

            let accion = 'modificar';

            if (
                Number(anterior.activo) === 0 &&
                Number(nuevo.activo) === 1
            ) {
                accion = 'activar';
            }

            if (
                Number(anterior.activo) === 1 &&
                Number(nuevo.activo) === 0
            ) {
                accion = 'desactivar';
            }

            await connection.query(
                `INSERT INTO auditoria_convenios (
                    id_empresa,
                    id_convenio,
                    id_usuario,
                    nombre_usuario,
                    rol_usuario,
                    accion,
                    datos_anteriores,
                    datos_nuevos,
                    ip_origen
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    req.user.id_empresa,
                    req.params.id,
                    req.user.id_usuario,
                    req.user.nombre ||
                        req.user.usuario_login ||
                        'Usuario',
                    req.user.rol,
                    accion,
                    JSON.stringify(anterior),
                    JSON.stringify(nuevo),
                    obtenerIP(req)
                ]
            );

            await connection.commit();

            res.json({
                success: true,
                data: nuevo,
                message:
                    accion === 'activar'
                        ? 'Convenio activado correctamente'
                        : accion === 'desactivar'
                            ? 'Convenio desactivado correctamente'
                            : 'Convenio actualizado correctamente'
            });

        } catch (error) {

            await connection.rollback();

            console.error(
                'Error actualizando convenio:',
                error
            );

            res.status(500).json({
                success: false,
                message: 'Error actualizando convenio'
            });

        } finally {
            connection.release();
        }
    }
);

module.exports = router;
