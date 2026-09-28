/*
 * Control global de menús por rol
 * LKCO Estacionamiento
 *
 * Roles:
 * admin      = Administrador
 * operador   = Operador
 * cajero     = Cajero
 */

(function () {
    'use strict';

    const role = localStorage.getItem('userRole') || '';

    function aplicarPermisosMenu() {

        // Solo Administrador
        if (role !== 'admin') {
            document.querySelectorAll('.admin-only').forEach(el => {
                el.classList.add('d-none');
            });
        }

        // Administrador + Operador
        if (role !== 'admin' && role !== 'operador') {
            document.querySelectorAll('.admin-operador').forEach(el => {
                el.classList.add('d-none');
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', aplicarPermisosMenu);
    } else {
        aplicarPermisosMenu();
    }

})();
