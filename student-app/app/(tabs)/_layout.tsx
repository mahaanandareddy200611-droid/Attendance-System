import { Tabs } from "expo-router";

export default function TabLayout() {
  return (
    <Tabs screenOptions={{ headerShown: false, tabBarActiveTintColor: "#3157d5" }}>
      <Tabs.Screen
        name="index"
        options={{ title: "Check in", tabBarLabel: "Check in" }}
      />
      <Tabs.Screen
        name="explore"
        options={{ title: "History", tabBarLabel: "History" }}
      />
    </Tabs>
  );
}
