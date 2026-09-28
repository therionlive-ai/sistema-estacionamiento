module.exports = function requireRoles(...roles) {
    return (req, res, next) => {
        if (!req.user || !roles.includes(req.user.rol)) {
            return res.status(403).json({ success: false, message: 'No tienes permisos para esta operación' });
        }
        next();
    };
};
