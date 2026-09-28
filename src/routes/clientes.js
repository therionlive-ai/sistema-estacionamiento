const express = require('express');
const router = express.Router();
const pool = require('../config/db');
const verifyToken = require('../middleware/auth');
const { sanitizeIdParam } = require('../utils/sanitize');

const TIPOS_CONTRIBUYENTE = [
    'persona_natural',
    'comerciante_individual',
    'persona_juridica'
];

const CAMPOS_AUDITABLES = [
    'id_cliente',
    'id_empresa',
    'rtn',
    'tipo_contribuyente',
    'nombre_razon_social',
    'nombre_comercial',
    'direccion',
    'telefono',
    'correo',
    'activo'
];

function normalizarRTN(rtn) {
    return String(rtn || '')
        .trim()
        .replace(/[\s-]/g, '')
        .toUpperCase();
}

function validarRTN(rtn) {
    return /^[0-9]{14}$/.test(rtn);
}

function validarTipoContribuyente(tipo) {
    return TIPOS_CONTRIBUYENTE.includes(tipo);
}

function rolPermitido(req, roles) {
    return roles.includes(req.user.rol);
}

function obtenerIP(req) {
    return (
        req.headers['x-forwarded-for']?.split(',')[0]?.trim() ||
        req.ip ||
        req.socket?.remoteAddress ||
        null
    );
}

function snapshotCliente(cliente) {
    if (!cliente) {
        return null;
    }

    const snapshot = {};

    for (const campo of CAMPOS_AUDITABLES) {
        if (Object.prototype.hasOwnProperty.call(cliente, campo)) {
            snapshot[campo] = cliente[campo];
        }
    }

    return snapshot;
}

function huboCambios(datosAnteriores, datosNuevos) {
    return JSON.stringify(datosAnteriores) !== JSON.stringify(datosNuevos);
}

async function obtenerCliente(connection, idEmpresa, idCliente) {
    const [clientes] = await connection.query(
        `
        SELECT
            id_cliente,
            id_empresa,
            rtn,
            tipo_contribuyente,
            nombre_razon_social,
            nombre_comercial,
            direccion,
            telefono,
            correo,
            activo,
            fecha_creacion,
            fecha_actualizacion
        FROM clientes
        WHERE id_empresa = ?
          AND id_cliente = ?
        LIMIT 1
        `,
        [idEmpresa, idCliente]
    );

    return clientes[0] || null;
}

async function registrarAuditoriaCliente(
    connection,
    {
        idEmpresa,
        idCliente,
        req,
        accion,
        datosAnteriores = null,
        datosNuevos = null
    }
) {
    await connection.query(
        `
        INSERT INTO auditoria_clientes (
            id_empresa,
            id_cliente,
            id_usuario,
            nombre_usuario,
            rol_usuario,
            accion,
            datos_anteriores,
            datos_nuevos,
            ip_origen
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
            idEmpresa,
            idCliente,
            req.user.id,
            req.user.nombre,
            req.user.rol,
            accion,
            datosAnteriores
                ? JSON.stringify(datosAnteriores)
                : null,
            datosNuevos
                ? JSON.stringify(datosNuevos)
                : null,
            obtenerIP(req)
        ]
    );
}

// ============================================================
// GET /api/clientes
// Listar clientes / buscar por RTN o nombre
// SOLO DE LA EMPRESA DEL USUARIO
// ============================================================
router.get('/', verifyToken, async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const q = String(req.query.q || '').trim();

        let sql = `
            SELECT
                id_cliente,
                id_empresa,
                rtn,
                tipo_contribuyente,
                nombre_razon_social,
                nombre_comercial,
                direccion,
                telefono,
                correo,
                activo,
                fecha_creacion,
                fecha_actualizacion
            FROM clientes
            WHERE id_empresa = ?
        `;

        const params = [idEmpresa];

        if (q) {
            const rtnBusqueda = normalizarRTN(q);

            sql += `
                AND (
                    rtn LIKE ?
                    OR nombre_razon_social LIKE ?
                    OR nombre_comercial LIKE ?
                )
            `;

            params.push(
                `${rtnBusqueda}%`,
                `%${q}%`,
                `%${q}%`
            );
        }

        sql += `
            ORDER BY nombre_razon_social ASC
            LIMIT 100
        `;

        const [clientes] = await pool.query(sql, params);

        return res.json({
            success: true,
            data: clientes
        });

    } catch (error) {
        console.error('Error al obtener clientes:', error);

        return res.status(500).json({
            success: false,
            message: 'Error al obtener los clientes'
        });
    }
});

// ============================================================
// GET /api/clientes/rtn/:rtn
// Buscar cliente exactamente por RTN
// SOLO DE LA EMPRESA DEL USUARIO
// ============================================================
router.get('/rtn/:rtn', verifyToken, async (req, res) => {
    try {
        const idEmpresa = req.user.id_empresa;
        const rtn = normalizarRTN(req.params.rtn);

        if (!validarRTN(rtn)) {
            return res.status(400).json({
                success: false,
                message: 'El RTN debe contener exactamente 14 dígitos'
            });
        }

        const [clientes] = await pool.query(
            `
            SELECT
                id_cliente,
                id_empresa,
                rtn,
                tipo_contribuyente,
                nombre_razon_social,
                nombre_comercial,
                direccion,
                telefono,
                correo,
                activo,
                fecha_creacion,
                fecha_actualizacion
            FROM clientes
            WHERE id_empresa = ?
              AND rtn = ?
            LIMIT 1
            `,
            [idEmpresa, rtn]
        );

        if (clientes.length === 0) {
            return res.status(404).json({
                success: false,
                exists: false,
                message: 'No existe un cliente registrado con este RTN'
            });
        }

        return res.json({
            success: true,
            exists: true,
            data: clientes[0]
        });

    } catch (error) {
        console.error('Error al buscar cliente por RTN:', error);

        return res.status(500).json({
            success: false,
            message: 'Error al buscar el cliente'
        });
    }
});

// ============================================================
// GET /api/clientes/:id/auditoria
// Historial de auditoría del cliente
// ADMINISTRADOR Y OPERADOR
// ============================================================
router.get(
    '/:id/auditoria',
    verifyToken,
    sanitizeIdParam('id'),
    async (req, res) => {
        try {
            if (!rolPermitido(req, ['admin', 'operador', 'cajero'])) {
                return res.status(403).json({
                    success: false,
                    message: 'No tiene permisos para consultar la auditoría de clientes'
                });
            }

            const idEmpresa = req.user.id_empresa;

            const cliente = await obtenerCliente(
                pool,
                idEmpresa,
                req.params.id
            );

            if (!cliente) {
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            const [auditoria] = await pool.query(
                `
                SELECT
                    id_auditoria,
                    id_empresa,
                    id_cliente,
                    id_usuario,
                    nombre_usuario,
                    rol_usuario,
                    accion,
                    datos_anteriores,
                    datos_nuevos,
                    ip_origen,
                    fecha_hora
                FROM auditoria_clientes
                WHERE id_empresa = ?
                  AND id_cliente = ?
                ORDER BY fecha_hora DESC, id_auditoria DESC
                LIMIT 100
                `,
                [idEmpresa, req.params.id]
            );

            return res.json({
                success: true,
                data: auditoria
            });

        } catch (error) {
            console.error('Error al obtener auditoría del cliente:', error);

            return res.status(500).json({
                success: false,
                message: 'Error al obtener la auditoría del cliente'
            });
        }
    }
);

// ============================================================
// GET /api/clientes/:id
// Obtener cliente específico
// SOLO DE LA EMPRESA DEL USUARIO
// ============================================================
router.get(
    '/:id',
    verifyToken,
    sanitizeIdParam('id'),
    async (req, res) => {
        try {
            const idEmpresa = req.user.id_empresa;

            const [clientes] = await pool.query(
                `
                SELECT
                    id_cliente,
                    id_empresa,
                    rtn,
                    tipo_contribuyente,
                    nombre_razon_social,
                    nombre_comercial,
                    direccion,
                    telefono,
                    correo,
                    activo,
                    fecha_creacion,
                    fecha_actualizacion
                FROM clientes
                WHERE id_empresa = ?
                  AND id_cliente = ?
                LIMIT 1
                `,
                [idEmpresa, req.params.id]
            );

            if (clientes.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            return res.json({
                success: true,
                data: clientes[0]
            });

        } catch (error) {
            console.error('Error al obtener cliente:', error);

            return res.status(500).json({
                success: false,
                message: 'Error al obtener el cliente'
            });
        }
    }
);

// ============================================================
// POST /api/clientes
// Crear cliente
// ADMINISTRADOR Y OPERADOR
// ============================================================
router.post('/', verifyToken, async (req, res) => {
    if (!rolPermitido(req, ['admin', 'operador', 'cajero'])) {
        return res.status(403).json({
            success: false,
            message: 'No tiene permisos para crear clientes'
        });
    }

    const connection = await pool.getConnection();

    try {
        const idEmpresa = req.user.id_empresa;

        let {
            rtn,
            tipo_contribuyente,
            nombre_razon_social,
            nombre_comercial,
            direccion,
            telefono,
            correo
        } = req.body;

        rtn = normalizarRTN(rtn);
        nombre_razon_social = String(nombre_razon_social || '').trim();

        if (!validarRTN(rtn)) {
            return res.status(400).json({
                success: false,
                message: 'El RTN debe contener exactamente 14 dígitos'
            });
        }

        if (!validarTipoContribuyente(tipo_contribuyente)) {
            return res.status(400).json({
                success: false,
                message: 'Tipo de contribuyente no válido'
            });
        }

        if (!nombre_razon_social) {
            return res.status(400).json({
                success: false,
                message: 'El nombre o razón social es obligatorio'
            });
        }

        await connection.beginTransaction();

        const [existente] = await connection.query(
            `
            SELECT
                id_cliente,
                id_empresa,
                rtn,
                nombre_razon_social,
                nombre_comercial,
                activo
            FROM clientes
            WHERE id_empresa = ?
              AND rtn = ?
            LIMIT 1
            FOR UPDATE
            `,
            [idEmpresa, rtn]
        );

        if (existente.length > 0) {
            await connection.rollback();

            return res.status(409).json({
                success: false,
                exists: true,
                message: 'Ya existe un cliente registrado con este RTN',
                data: existente[0]
            });
        }

        const [result] = await connection.query(
            `
            INSERT INTO clientes (
                id_empresa,
                rtn,
                tipo_contribuyente,
                nombre_razon_social,
                nombre_comercial,
                direccion,
                telefono,
                correo
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `,
            [
                idEmpresa,
                rtn,
                tipo_contribuyente,
                nombre_razon_social,
                nombre_comercial || null,
                direccion || null,
                telefono || null,
                correo || null
            ]
        );

        const clienteCreado = await obtenerCliente(
            connection,
            idEmpresa,
            result.insertId
        );

        const datosNuevos = snapshotCliente(clienteCreado);

        await registrarAuditoriaCliente(connection, {
            idEmpresa,
            idCliente: result.insertId,
            req,
            accion: 'crear',
            datosAnteriores: null,
            datosNuevos
        });

        await connection.commit();

        return res.status(201).json({
            success: true,
            message: 'Cliente registrado exitosamente',
            id: result.insertId
        });

    } catch (error) {
        await connection.rollback();

        if (error.code === 'ER_DUP_ENTRY') {
            return res.status(409).json({
                success: false,
                exists: true,
                message: 'Ya existe un cliente registrado con este RTN'
            });
        }

        console.error('Error al crear cliente:', error);

        return res.status(500).json({
            success: false,
            message: 'Error al registrar el cliente'
        });

    } finally {
        connection.release();
    }
});

// ============================================================
// PUT /api/clientes/:id
// Modificar cliente
// ADMINISTRADOR Y OPERADOR
// ============================================================
router.put(
    '/:id',
    verifyToken,
    sanitizeIdParam('id'),
    async (req, res) => {

        if (!rolPermitido(req, ['admin', 'operador'])) {
            return res.status(403).json({
                success: false,
                message: 'No tiene permisos para modificar clientes'
            });
        }

        const connection = await pool.getConnection();

        try {
            const idEmpresa = req.user.id_empresa;

            let {
                rtn,
                tipo_contribuyente,
                nombre_razon_social,
                nombre_comercial,
                direccion,
                telefono,
                correo,
                activo
            } = req.body;

            rtn = normalizarRTN(rtn);
            nombre_razon_social = String(nombre_razon_social || '').trim();

            if (!validarRTN(rtn)) {
                return res.status(400).json({
                    success: false,
                    message: 'El RTN debe contener exactamente 14 dígitos'
                });
            }

            if (!validarTipoContribuyente(tipo_contribuyente)) {
                return res.status(400).json({
                    success: false,
                    message: 'Tipo de contribuyente no válido'
                });
            }

            if (!nombre_razon_social) {
                return res.status(400).json({
                    success: false,
                    message: 'El nombre o razón social es obligatorio'
                });
            }

            await connection.beginTransaction();

            const clienteActual = await obtenerCliente(
                connection,
                idEmpresa,
                req.params.id
            );

            if (!clienteActual) {
                await connection.rollback();

                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            const datosAnteriores = snapshotCliente(clienteActual);

            const [duplicado] = await connection.query(
                `
                SELECT
                    id_cliente,
                    id_empresa,
                    rtn,
                    nombre_razon_social
                FROM clientes
                WHERE id_empresa = ?
                  AND rtn = ?
                  AND id_cliente <> ?
                LIMIT 1
                FOR UPDATE
                `,
                [idEmpresa, rtn, req.params.id]
            );

            if (duplicado.length > 0) {
                await connection.rollback();

                return res.status(409).json({
                    success: false,
                    exists: true,
                    message: 'El RTN ya pertenece a otro cliente',
                    data: duplicado[0]
                });
            }

            // El operador puede modificar los datos del cliente,
            // pero NO puede cambiar su estado activo/inactivo.
            let nuevoActivo = clienteActual.activo;

            if (req.user.rol === 'admin' && activo !== undefined) {
                nuevoActivo = activo ? 1 : 0;
            }

            await connection.query(
                `
                UPDATE clientes
                SET
                    rtn = ?,
                    tipo_contribuyente = ?,
                    nombre_razon_social = ?,
                    nombre_comercial = ?,
                    direccion = ?,
                    telefono = ?,
                    correo = ?,
                    activo = ?
                WHERE id_empresa = ?
                  AND id_cliente = ?
                `,
                [
                    rtn,
                    tipo_contribuyente,
                    nombre_razon_social,
                    nombre_comercial || null,
                    direccion || null,
                    telefono || null,
                    correo || null,
                    nuevoActivo,
                    idEmpresa,
                    req.params.id
                ]
            );

            const clienteActualizado = await obtenerCliente(
                connection,
                idEmpresa,
                req.params.id
            );

            const datosNuevos = snapshotCliente(clienteActualizado);

            const cambio = huboCambios(
                datosAnteriores,
                datosNuevos
            );

            if (cambio) {
                await registrarAuditoriaCliente(connection, {
                    idEmpresa,
                    idCliente: Number(req.params.id),
                    req,
                    accion: 'modificar',
                    datosAnteriores,
                    datosNuevos
                });
            }

            await connection.commit();

            return res.json({
                success: true,
                changed: cambio,
                message: cambio
                    ? 'Cliente actualizado exitosamente'
                    : 'No se detectaron cambios en el cliente'
            });

        } catch (error) {
            await connection.rollback();

            if (error.code === 'ER_DUP_ENTRY') {
                return res.status(409).json({
                    success: false,
                    exists: true,
                    message: 'El RTN ya pertenece a otro cliente'
                });
            }

            console.error('Error al actualizar cliente:', error);

            return res.status(500).json({
                success: false,
                message: 'Error al actualizar el cliente'
            });

        } finally {
            connection.release();
        }
    }
);

// ============================================================
// PATCH /api/clientes/:id/estado
// Desactivar / reactivar cliente
// SOLO ADMINISTRADOR
// ============================================================
router.patch(
    '/:id/estado',
    verifyToken,
    sanitizeIdParam('id'),
    async (req, res) => {

        if (req.user.rol !== 'admin') {
            return res.status(403).json({
                success: false,
                message: 'Solo un administrador puede desactivar o reactivar clientes'
            });
        }

        const connection = await pool.getConnection();

        try {
            const idEmpresa = req.user.id_empresa;
            const activo = req.body.activo ? 1 : 0;

            await connection.beginTransaction();

            const clienteActual = await obtenerCliente(
                connection,
                idEmpresa,
                req.params.id
            );

            if (!clienteActual) {
                await connection.rollback();

                return res.status(404).json({
                    success: false,
                    message: 'Cliente no encontrado'
                });
            }

            const datosAnteriores = snapshotCliente(clienteActual);

            if (Number(clienteActual.activo) === activo) {
                await connection.rollback();

                return res.json({
                    success: true,
                    changed: false,
                    message: activo
                        ? 'El cliente ya está activo'
                        : 'El cliente ya está inactivo'
                });
            }

            await connection.query(
                `
                UPDATE clientes
                SET activo = ?
                WHERE id_empresa = ?
                  AND id_cliente = ?
                `,
                [
                    activo,
                    idEmpresa,
                    req.params.id
                ]
            );

            const clienteActualizado = await obtenerCliente(
                connection,
                idEmpresa,
                req.params.id
            );

            const datosNuevos = snapshotCliente(clienteActualizado);

            await registrarAuditoriaCliente(connection, {
                idEmpresa,
                idCliente: Number(req.params.id),
                req,
                accion: activo ? 'reactivar' : 'desactivar',
                datosAnteriores,
                datosNuevos
            });

            await connection.commit();

            return res.json({
                success: true,
                changed: true,
                message: activo
                    ? 'Cliente reactivado exitosamente'
                    : 'Cliente desactivado exitosamente'
            });

        } catch (error) {
            await connection.rollback();

            console.error('Error al cambiar estado del cliente:', error);

            return res.status(500).json({
                success: false,
                message: 'Error al cambiar el estado del cliente'
            });

        } finally {
            connection.release();
        }
    }
);

module.exports = router;
