const token = localStorage.getItem('token');
const userRole = localStorage.getItem('userRole') || '';
const userName = localStorage.getItem('userName') || 'Usuario';

const clienteModal = new bootstrap.Modal(
    document.getElementById('clienteModal')
);

const auditoriaModal = new bootstrap.Modal(
    document.getElementById('auditoriaModal')
);

let clientes = [];

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('userName').textContent = userName;

    configurarPermisos();
    cargarClientes();

    document
        .getElementById('btnNuevoCliente')
        .addEventListener('click', nuevoCliente);

    document
        .getElementById('clienteForm')
        .addEventListener('submit', guardarCliente);

    document
        .getElementById('btnBuscarRtn')
        .addEventListener('click', buscarPorRTN);

    document
        .getElementById('buscarRtn')
        .addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                e.preventDefault();
                buscarPorRTN();
            }
        });

    document
        .getElementById('buscarNombre')
        .addEventListener('input', debounce(cargarClientes, 300));

    document
        .getElementById('btnLimpiar')
        .addEventListener('click', limpiarBusqueda);

    document
        .getElementById('btnLogout')
        .addEventListener('click', cerrarSesion);
});

function configurarPermisos() {

    const puedeGestionar =
        userRole === 'admin' ||
        userRole === 'operador';

    const puedeCrear =
        userRole === 'admin' ||
        userRole === 'operador' ||
        userRole === 'cajero';

    const puedeAuditar =
        userRole === 'admin' ||
        userRole === 'operador';

    if (!puedeCrear) {
        document.getElementById('btnNuevoCliente').style.display = 'none';
    }

    window.puedeGestionarClientes = puedeGestionar;
    window.puedeAuditarClientes = puedeAuditar;
}

async function cargarClientes() {

    try {

        const nombre = document
            .getElementById('buscarNombre')
            .value
            .trim();

        const url = nombre
            ? `/api/clientes?q=${encodeURIComponent(nombre)}`
            : '/api/clientes';

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        const json = await response.json();

        if (!response.ok) {
            throw new Error(
                json.message || 'Error al cargar clientes'
            );
        }

        clientes = json.data || [];

        renderClientes();

    } catch (error) {

        console.error('Error cargando clientes:', error);

        mostrarAlerta(
            'danger',
            error.message || 'No fue posible cargar los clientes'
        );
    }
}

async function buscarPorRTN() {

    const rtn = document
        .getElementById('buscarRtn')
        .value
        .trim();

    if (!rtn) {
        cargarClientes();
        return;
    }

    if (!/^[0-9]{14}$/.test(rtn.replace(/[\s-]/g, ''))) {
        mostrarAlerta(
            'warning',
            'El RTN debe contener exactamente 14 dígitos'
        );
        return;
    }

    try {

        const response = await fetch(
            `/api/clientes/rtn/${encodeURIComponent(rtn)}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        const json = await response.json();

        if (response.status === 404) {
            clientes = [];
            renderClientes();

            mostrarAlerta(
                'info',
                'No existe un cliente registrado con este RTN'
            );

            return;
        }

        if (!response.ok) {
            throw new Error(
                json.message || 'Error al buscar cliente'
            );
        }

        clientes = json.data ? [json.data] : [];

        renderClientes();

    } catch (error) {

        console.error('Error buscando RTN:', error);

        mostrarAlerta(
            'danger',
            error.message || 'Error al buscar cliente'
        );
    }
}

function renderClientes() {

    const tbody = document.getElementById('clientesTableBody');

    tbody.innerHTML = '';

    if (!clientes.length) {

        tbody.innerHTML = `
            <tr>
                <td colspan="7"
                    class="text-center text-muted py-4">
                    No hay clientes registrados.
                </td>
            </tr>
        `;

        return;
    }

    clientes.forEach(cliente => {

        const tr = document.createElement('tr');

        const estado = Number(cliente.activo) === 1;

        tr.innerHTML = `
            <td>
                <strong>${escapeHtml(cliente.rtn || '')}</strong>
            </td>

            <td>
                ${escapeHtml(cliente.nombre_razon_social || '')}
            </td>

            <td>
                ${escapeHtml(cliente.nombre_comercial || '—')}
            </td>

            <td>
                ${escapeHtml(cliente.telefono || '—')}
            </td>

            <td>
                ${escapeHtml(cliente.correo || '—')}
            </td>

            <td>
                ${
                    estado
                        ? '<span class="badge bg-success">Activo</span>'
                        : '<span class="badge bg-secondary">Inactivo</span>'
                }
            </td>

            <td class="text-end">
                ${accionesCliente(cliente)}
            </td>
        `;

        tbody.appendChild(tr);
    });
}

function accionesCliente(cliente) {

    const id = Number(cliente.id_cliente);
    const estado = Number(cliente.activo) === 1;

    let html = '';

    if (userRole === 'admin' || userRole === 'operador') {

        html += `
            <button
                class="btn btn-sm btn-info me-1"
                title="Editar"
                onclick="editarCliente(${id})">
                <i class="fas fa-edit"></i>
            </button>
        `;
    }

    if (userRole === 'admin') {

        html += `
            <button
                class="btn btn-sm ${
                    estado ? 'btn-warning' : 'btn-success'
                } me-1"
                title="${
                    estado ? 'Desactivar' : 'Reactivar'
                }"
                onclick="cambiarEstadoCliente(${id}, ${estado})">

                <i class="fas ${
                    estado
                        ? 'fa-user-slash'
                        : 'fa-user-check'
                }"></i>

            </button>
        `;
    }

    if (userRole === 'admin' || userRole === 'operador') {

        html += `
            <button
                class="btn btn-sm btn-secondary"
                title="Ver auditoría"
                onclick="verAuditoria(${id})">

                <i class="fas fa-clock-rotate-left"></i>

            </button>
        `;
    }

    if (!html) {
        html = '<span class="text-muted">Consulta</span>';
    }

    return html;
}

function nuevoCliente() {

    document.getElementById('clienteModalTitle').textContent =
        'Nuevo Cliente';

    document.getElementById('clienteForm').reset();

    document.getElementById('idCliente').value = '';

    document.getElementById('estadoContainer').style.display = 'none';

    document.getElementById('activo').checked = true;

    clienteModal.show();
}

async function editarCliente(id) {

    try {

        const response = await fetch(
            `/api/clientes/${id}`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        const json = await response.json();

        if (!response.ok) {
            throw new Error(
                json.message || 'Error al obtener cliente'
            );
        }

        const cliente = json.data;

        document.getElementById('clienteModalTitle').textContent =
            'Modificar Cliente';

        document.getElementById('idCliente').value =
            cliente.id_cliente;

        document.getElementById('rtn').value =
            cliente.rtn || '';

        document.getElementById('tipoContribuyente').value =
            cliente.tipo_contribuyente || '';

        document.getElementById('nombreRazonSocial').value =
            cliente.nombre_razon_social || '';

        document.getElementById('nombreComercial').value =
            cliente.nombre_comercial || '';

        document.getElementById('direccion').value =
            cliente.direccion || '';

        document.getElementById('telefono').value =
            cliente.telefono || '';

        document.getElementById('correo').value =
            cliente.correo || '';

        document.getElementById('activo').checked =
            Number(cliente.activo) === 1;

        document.getElementById('estadoContainer').style.display =
            userRole === 'admin' ? 'block' : 'none';

        clienteModal.show();

    } catch (error) {

        console.error('Error editando cliente:', error);

        mostrarAlerta(
            'danger',
            error.message || 'No fue posible cargar el cliente'
        );
    }
}

async function guardarCliente(event) {

    event.preventDefault();

    if (
        userRole !== 'admin' &&
        userRole !== 'operador'
    ) {
        mostrarAlerta(
            'danger',
            'No tiene permisos para modificar clientes'
        );
        return;
    }

    const id = document
        .getElementById('idCliente')
        .value
        .trim();

    const datos = {

        rtn: document
            .getElementById('rtn')
            .value
            .trim(),

        tipo_contribuyente: document
            .getElementById('tipoContribuyente')
            .value,

        nombre_razon_social: document
            .getElementById('nombreRazonSocial')
            .value
            .trim(),

        nombre_comercial: document
            .getElementById('nombreComercial')
            .value
            .trim(),

        direccion: document
            .getElementById('direccion')
            .value
            .trim(),

        telefono: document
            .getElementById('telefono')
            .value
            .trim(),

        correo: document
            .getElementById('correo')
            .value
            .trim()
    };

    if (userRole === 'admin' && id) {
        datos.activo =
            document.getElementById('activo').checked;
    }

    try {

        const url = id
            ? `/api/clientes/${id}`
            : '/api/clientes';

        const method = id ? 'PUT' : 'POST';

        const response = await fetch(url, {

            method,

            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },

            body: JSON.stringify(datos)
        });

        const json = await response.json();

        if (!response.ok) {

            if (json.exists && json.data) {

                mostrarAlerta(
                    'warning',
                    `El RTN ya está registrado para ${json.data.nombre_razon_social || 'otro cliente'}`
                );

            } else {

                throw new Error(
                    json.message || 'Error al guardar cliente'
                );
            }

            return;
        }

        clienteModal.hide();

        mostrarAlerta(
            'success',
            json.message ||
            (id
                ? 'Cliente actualizado correctamente'
                : 'Cliente registrado correctamente')
        );

        await cargarClientes();

    } catch (error) {

        console.error('Error guardando cliente:', error);

        mostrarAlerta(
            'danger',
            error.message || 'No fue posible guardar el cliente'
        );
    }
}

async function cambiarEstadoCliente(id, estadoActual) {

    if (userRole !== 'admin') {
        mostrarAlerta(
            'danger',
            'Solo un administrador puede cambiar el estado del cliente'
        );
        return;
    }

    const nuevoEstado = !estadoActual;

    const accion = nuevoEstado
        ? 'reactivar'
        : 'desactivar';

    const confirmacion = confirm(
        nuevoEstado
            ? '¿Desea reactivar este cliente?'
            : '¿Desea desactivar este cliente?'
    );

    if (!confirmacion) {
        return;
    }

    try {

        const response = await fetch(
            `/api/clientes/${id}/estado`,
            {
                method: 'PATCH',

                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                },

                body: JSON.stringify({
                    activo: nuevoEstado
                })
            }
        );

        const json = await response.json();

        if (!response.ok) {
            throw new Error(
                json.message ||
                `No fue posible ${accion} el cliente`
            );
        }

        mostrarAlerta(
            'success',
            json.message ||
            (
                nuevoEstado
                    ? 'Cliente reactivado'
                    : 'Cliente desactivado'
            )
        );

        await cargarClientes();

    } catch (error) {

        console.error('Error cambiando estado:', error);

        mostrarAlerta(
            'danger',
            error.message ||
            'No fue posible cambiar el estado del cliente'
        );
    }
}

async function verAuditoria(id) {

    try {

        const response = await fetch(
            `/api/clientes/${id}/auditoria`,
            {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            }
        );

        const json = await response.json();

        if (!response.ok) {
            throw new Error(
                json.message ||
                'No fue posible obtener la auditoría'
            );
        }

        renderAuditoria(json.data || []);

        auditoriaModal.show();

    } catch (error) {

        console.error('Error obteniendo auditoría:', error);

        mostrarAlerta(
            'danger',
            error.message ||
            'No fue posible obtener la auditoría'
        );
    }
}

function renderAuditoria(registros) {

    const contenedor =
        document.getElementById('auditoriaContenido');

    if (!registros.length) {

        contenedor.innerHTML = `
            <div class="alert alert-info mb-0">
                No existen registros de auditoría para este cliente.
            </div>
        `;

        return;
    }

    let html = `
        <div class="table-responsive">

            <table class="table table-bordered table-sm align-middle">

                <thead>
                    <tr>
                        <th>Fecha / Hora</th>
                        <th>Usuario</th>
                        <th>Rol</th>
                        <th>Acción</th>
                        <th>IP</th>
                        <th>Datos</th>
                    </tr>
                </thead>

                <tbody>
    `;

    registros.forEach(registro => {

        html += `
            <tr>

                <td>
                    ${escapeHtml(
                        formatearFecha(registro.fecha_hora)
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        registro.nombre_usuario || ''
                    )}
                </td>

                <td>
                    ${escapeHtml(
                        registro.rol_usuario || ''
                    )}
                </td>

                <td>
                    ${badgeAccion(registro.accion)}
                </td>

                <td>
                    ${escapeHtml(
                        registro.ip_origen || 'N/A'
                    )}
                </td>

                <td>
                    ${renderCambios(registro)}
                </td>

            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
        </div>
    `;

    contenedor.innerHTML = html;
}

function badgeAccion(accion) {

    const clases = {
        crear: 'bg-success',
        modificar: 'bg-primary',
        desactivar: 'bg-warning text-dark',
        reactivar: 'bg-success'
    };

    const nombres = {
        crear: 'Crear',
        modificar: 'Modificar',
        desactivar: 'Desactivar',
        reactivar: 'Reactivar'
    };

    return `
        <span class="badge ${clases[accion] || 'bg-secondary'}">
            ${escapeHtml(nombres[accion] || accion || '')}
        </span>
    `;
}

function renderCambios(registro) {

    let anterior = null;
    let nuevo = null;

    try {
        anterior = registro.datos_anteriores
            ? JSON.parse(registro.datos_anteriores)
            : null;
    } catch (_) {
        anterior = null;
    }

    try {
        nuevo = registro.datos_nuevos
            ? JSON.parse(registro.datos_nuevos)
            : null;
    } catch (_) {
        nuevo = null;
    }

    if (!anterior && nuevo) {

        return `
            <button
                class="btn btn-sm btn-outline-primary"
                onclick='mostrarDetalleAuditoria(${JSON.stringify(nuevo)})'>
                Ver datos
            </button>
        `;
    }

    if (anterior && nuevo) {

        return `
            <button
                class="btn btn-sm btn-outline-primary"
                onclick='mostrarDetalleCambios(
                    ${JSON.stringify(anterior)},
                    ${JSON.stringify(nuevo)}
                )'>
                Ver cambios
            </button>
        `;
    }

    return '<span class="text-muted">Sin datos</span>';
}

function mostrarDetalleAuditoria(datos) {

    alert(
        Object.entries(datos)
            .map(([campo, valor]) =>
                `${campo}: ${valor ?? ''}`
            )
            .join('\n')
    );
}

function mostrarDetalleCambios(anterior, nuevo) {

    const campos = new Set([
        ...Object.keys(anterior || {}),
        ...Object.keys(nuevo || {})
    ]);

    const cambios = [];

    campos.forEach(campo => {

        const antes = anterior?.[campo] ?? '';
        const despues = nuevo?.[campo] ?? '';

        if (String(antes) !== String(despues)) {

            cambios.push(
                `${campo}\n` +
                `Anterior: ${antes}\n` +
                `Nuevo: ${despues}`
            );
        }
    });

    alert(
        cambios.length
            ? cambios.join('\n\n')
            : 'No se detectaron cambios.'
    );
}

function limpiarBusqueda() {

    document.getElementById('buscarRtn').value = '';
    document.getElementById('buscarNombre').value = '';

    cargarClientes();
}

function mostrarAlerta(tipo, mensaje) {

    const container =
        document.getElementById('alertContainer');

    container.innerHTML = `
        <div class="alert alert-${tipo} alert-dismissible fade show"
             role="alert">

            ${escapeHtml(mensaje)}

            <button
                type="button"
                class="btn-close"
                data-bs-dismiss="alert">
            </button>

        </div>
    `;

    setTimeout(() => {

        const alert =
            container.querySelector('.alert');

        if (alert) {
            alert.remove();
        }

    }, 5000);
}

function formatearFecha(fecha) {

    if (!fecha) {
        return 'N/A';
    }

    const d = new Date(fecha);

    if (Number.isNaN(d.getTime())) {
        return fecha;
    }

    return d.toLocaleString(
        'es-HN',
        {
            dateStyle: 'short',
            timeStyle: 'medium'
        }
    );
}

function escapeHtml(valor) {

    return String(valor ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function debounce(fn, delay) {

    let timer;

    return function () {

        clearTimeout(timer);

        timer = setTimeout(
            fn,
            delay
        );
    };
}

function cerrarSesion(event) {

    event.preventDefault();

    localStorage.removeItem('token');
    localStorage.removeItem('userRole');
    localStorage.removeItem('userName');

    window.location.href = '/';
}
