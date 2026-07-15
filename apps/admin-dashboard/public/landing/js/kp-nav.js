// Mobile nav toggle for the Katana Pay static pages. Delegated click handling so it
// works regardless of where the hamburger sits in the nav; closes on link tap / outside tap.
(function () {
	document.addEventListener('click', function (e) {
		var nav = document.querySelector('.kp-nav');
		if (!nav) return;
		if (e.target.closest('.kp-nav__toggle')) { nav.classList.toggle('open'); return; }
		if (nav.classList.contains('open') && (e.target.closest('.kp-nav__links a') || !e.target.closest('.kp-nav'))) {
			nav.classList.remove('open');
		}
	});
})();
