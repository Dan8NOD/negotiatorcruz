(function(){
  var scenes = {
    deck: [['Rapport','Mirror','Repeat the last 1–3 words back and stop talking.'],
           ['Rapport','Label','Name the emotion out loud to take its power down.'],
           ['Rapport','Dynamic Silence','Say nothing for three seconds and let it work.']],
    listen: [['Signal','Tonal Shift','Their voice just changed register — that’s the tell.'],
             ['Signal','The Pause','A beat too long before "yes" means it isn’t yes yet.'],
             ['Signal','Over-Explaining','Extra justification nobody asked for — they’re unsure.']],
    wheel: [['Emotion','Name It','7 core emotions, 3 levels deep — tap to go further.'],
            ['Emotion','Read the Room','Match their word to a wedge before you respond.'],
            ['Emotion','Calibrate','The right label lowers the temperature fast.']],
    haggle: [['Anchor','Ackerman Model','A live calculator walks the four-step concession curve.'],
             ['Anchor','The Extreme Anchor','Go first, go bold, let them negotiate down from there.'],
             ['Anchor','Non-Cash Terms','Trade what costs you little for what they value a lot.']]
  };
  var esc = function(s){ return String(s).replace(/[&<>"]/g, function(c){ return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'})[c]; }); };
  function cardHtml(cat,name,desc){
    return '<div class="mm-adcard"><div class="mm-adcat">'+esc(cat)+'</div><div class="mm-adname">'+esc(name)+'</div><div class="mm-addesc">'+esc(desc)+'</div></div>';
  }
  document.querySelectorAll('.mm-adwrap').forEach(function(wrap){
    var body = wrap.querySelector('.mm-adbody');
    var tabs = wrap.querySelectorAll('.mm-adtab');
    var order = ['deck','listen','wheel','haggle'];
    function render(key){
      var rows = scenes[key] || scenes.deck;
      body.style.opacity = '0';
      setTimeout(function(){
        body.innerHTML = rows.map(function(r){ return cardHtml(r[0],r[1],r[2]); }).join('');
        body.style.opacity = '1';
      }, 200);
    }
    render('deck');
    // Static for reduced-motion users: they still get the full first scene.
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var idx = 0;
    setInterval(function(){
      // Skip the swap when nobody can see it — background tab, or scrolled past.
      if (document.hidden) return;
      var box = wrap.getBoundingClientRect();
      if (box.bottom < 0 || box.top > innerHeight) return;
      idx = (idx + 1) % order.length;
      var key = order[idx];
      tabs.forEach(function(t){ t.classList.toggle('on', t.getAttribute('data-scene') === key); });
      render(key);
    }, 3600);
  });
})();
