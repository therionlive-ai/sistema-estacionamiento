(function () {
    if (window.__lkcoFooterInjected) return;
    window.__lkcoFooterInjected = true;

    function mount() {
        if (!document.body || document.querySelector('.lkco-footer')) return;
        const footer = document.createElement('footer');
        footer.className = 'lkco-footer text-center py-3 mt-4 text-muted';
        footer.innerHTML = '<small>LKCO S.A. de C.V. · Sistema de Gestión de Estacionamiento</small>';
        document.body.appendChild(footer);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
