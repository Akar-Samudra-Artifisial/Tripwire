import { mount } from './mount';
import { Placeholder, Shell } from './components';

mount(
  <Shell title="Decision Health">
    <Placeholder description="Every decision per team, marked healthy, near threshold, tripped or not monitored." />
  </Shell>,
);
