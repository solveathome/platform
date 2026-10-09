/* The front page's figures come with the page (src/lib/home.ts renders them in the first HTML), so nothing is fetched or
   rewritten here. What stays is the person: the header's sign-in state, and the join button, which points a signed-in
   visitor back at the problems instead of at a sign-in they have done. */
(function () {
  loadWho(document.querySelector('#who')).then(user => {
    if (!user?.signed_in) return;
    const cta = document.querySelector('#mf-join-cta');
    if (cta) { cta.href = '#problems'; cta.innerHTML = 'Choose a problem <span aria-hidden="true">↑</span>'; }
  }).catch(() => {});
})();
